// ============================================================
// POST /api/hooks/[token] — the "Incoming Webhook" automation trigger.
//
// The inbound mirror of the `send_webhook` step: instead of *this app*
// calling an external URL, an external system (a landing page, Shopify,
// a payment gateway, Zapier/Make/n8n, a client's own backend) POSTs
// here to fire ONE specific automation — without a WhatsApp message
// ever arriving first.
//
// Because this one URL has to work for every kind of external system a
// user might wire in — each shaping its JSON differently — the route
// doesn't assume a fixed body. Two ways a request gets turned into
// CRM fields:
//
//   1. `field_mapping` configured on the automation (the normal path,
//      set up via the builder's "capture test data → map fields" flow,
//      AiSensy/Intercom-style): dot-paths into WHATEVER shape the body
//      actually is, e.g. `{ phone: "contact.phone", name: "full_name" }`.
//   2. No `field_mapping` at all: the original fixed shape,
//      `{ phone, name, vars }` at the top level — kept for a technical
//      integrator who'd rather just conform to that contract.
//
// See `@/lib/automations/webhook-fields` for both paths. A mapped
// `tags` field is resolved into real CRM tags (created if they don't
// exist yet) via `@/lib/contacts/tag-find-or-create`, not just handed
// to steps as inert text — same as AiSensy/Intercom's own tag mapping.
// `email`/`company` and any mapped `custom_fields` are written onto the
// contact record itself (visible in the Contacts list / contact
// detail, CSV export, segment filters) via
// `@/lib/contacts/custom-field-write` — distinct from `vars`, which
// only ever lives inside a rendered message.
//
// Every valid-token request is also recorded onto the automation's
// `webhook_samples` column (rolling window, newest first) REGARDLESS of
// whether the automation is active or mapped yet — that's what lets the
// builder's "capture test data" step show real payloads to map from
// before the integration is fully wired up, exactly like fields
// captured this way in AiSensy/Intercom-style webhook triggers.
//
// Auth: the token in the URL path IS the credential — there is no
// header, no API key, nothing else to check. That's deliberate (a
// non-technical user pastes one URL into a form builder and is done),
// which is exactly why the token must be unguessable (see
// `generateWebhookToken`) and why this route never accepts a
// client-supplied token anywhere else (see the automations POST/PATCH
// routes) and rate-limits per token below.
//
// Response: `{ data: { contact_id, contact_created, automation_ran } }`
// on success (`automation_ran: false` means the request was captured
// but the automation isn't active/mapped yet, so nothing fired), or the
// standard `{ error: { code, message } }` envelope (see
// `@/lib/api/v1/respond`) — same shape the rest of the public API
// speaks, since this endpoint is just as public-facing as `/api/v1/*`.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { resolveWebhookFields } from '@/lib/automations/webhook-fields'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { findOrCreateTagsByName } from '@/lib/contacts/tag-find-or-create'
import { upsertContactCustomValues } from '@/lib/contacts/custom-field-write'
import { ok, fail, toApiErrorResponse, rateLimited } from '@/lib/api/v1/respond'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import type { IncomingWebhookTriggerConfig, WebhookSample } from '@/types'

/** Payload size guard — this is JSON typed by hand into a form
 *  builder, not a file upload; 32KB is generous headroom over any
 *  realistic lead/order payload while bounding a malicious or
 *  misconfigured integration that free-loops a huge body at the
 *  per-token rate limit. */
const MAX_BODY_BYTES = 32_768
/** Rolling window size for `webhook_samples` — enough to see a
 *  handful of real hits from different code paths on the sender's
 *  side (e.g. success + a couple of edge-case orders) without the
 *  column growing unbounded under a live, already-mapped integration
 *  that keeps sending. */
const MAX_WEBHOOK_SAMPLES = 20

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params
    if (!token || token.length < 16) {
      // Too short to be a real generated token — refuse before touching
      // the DB or the rate limiter at all.
      return fail('not_found', 'No automation found for this URL', 404)
    }

    // Per-token, not per-caller-IP: a legitimate integration (Shopify,
    // a landing page host) can fire from a shared or rotating IP, and
    // the token itself is the thing worth bounding abuse of.
    const limit = checkRateLimit(`incoming-webhook:${token}`, RATE_LIMITS.incomingWebhook)
    if (!limit.success) return toApiErrorResponse(rateLimited(limit))

    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (contentLength > MAX_BODY_BYTES) {
      return fail('bad_request', 'Request body too large', 413)
    }

    const db = supabaseAdmin()

    // Reverse lookup: token → the one automation it belongs to. The
    // unique index in migration 048 guarantees at most one row can
    // ever match. Unlike the old version of this route, an inactive
    // automation is NOT collapsed into the same 404 as "no such token"
    // — capturing test data while the automation is still being set up
    // (necessarily inactive; see validate.ts) is the whole point of
    // this flow, so a real token has to resolve even then. A caller
    // without the token learns nothing either way, since the token
    // itself — 192 random bits — is unguessable; that's the actual
    // security boundary, not the active/inactive distinction.
    const { data: automation, error: lookupErr } = await db
      .from('automations')
      .select('id, account_id, user_id, is_active, trigger_config, webhook_samples')
      .eq('trigger_type', 'incoming_webhook')
      .filter('trigger_config->>token', 'eq', token)
      .maybeSingle()

    if (lookupErr) {
      console.error('[hooks] automation lookup failed:', lookupErr)
      return fail('internal', 'Internal server error', 500)
    }
    if (!automation) {
      return fail('not_found', 'No automation found for this URL', 404)
    }
    const cfg = automation.trigger_config as IncomingWebhookTriggerConfig
    if (cfg?.token !== token) {
      // Belt-and-braces: the DB filter above already enforces this,
      // but never trust a network round trip's WHERE clause alone when
      // the whole route's security rests on this one equality.
      return fail('not_found', 'No automation found for this URL', 404)
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400)
    }

    // Record the sample first, before any validation of its content —
    // a malformed or not-yet-mappable payload is exactly what the
    // "capture test data" step exists to show the user. Best-effort:
    // a failure here should never block the automation itself from
    // running below.
    const existingSamples = (automation.webhook_samples ?? []) as WebhookSample[]
    const nextSamples: WebhookSample[] = [
      { received_at: new Date().toISOString(), payload: body },
      ...existingSamples,
    ].slice(0, MAX_WEBHOOK_SAMPLES)
    await db
      .from('automations')
      .update({ webhook_samples: nextSamples })
      .eq('id', automation.id)
      .then(({ error }) => {
        if (error) console.error('[hooks] failed to record capture sample:', error)
      })

    if (!automation.is_active) {
      // Captured above so the builder can show it, but nothing to run
      // yet — same generic 404 the old behavior used for "off", since a
      // caller with the token has no legitimate reason to distinguish
      // "wrong token" from "right token, automation not live" beyond
      // what the builder itself already tells the account owner.
      return fail('not_found', 'No automation found for this URL', 404)
    }

    const resolvedFields = resolveWebhookFields(body, cfg.field_mapping)
    if (!resolvedFields.phone) {
      return fail(
        'bad_request',
        cfg.field_mapping
          ? "Could not resolve a phone number from the mapped field — check the automation's field mapping"
          : "'phone' is required",
        400,
      )
    }

    let resolved
    try {
      resolved = await resolveConversationByPhone(
        db,
        automation.account_id,
        resolvedFields.phone,
        resolvedFields.name,
        { email: resolvedFields.email, company: resolvedFields.company },
      )
    } catch (err) {
      if (err instanceof SendMessageError) {
        return fail(err.code, err.message, err.status)
      }
      throw err
    }

    // `tags` from the mapping becomes real CRM tags — matching
    // AiSensy/Intercom-style behavior, where a tag name arriving in a
    // webhook payload shows up as an actual tag on the contact, not
    // just inert text. Best-effort and never blocking: a tag lookup/
    // creation failure shouldn't stop the automation itself from
    // running (the error is logged by `findOrCreateTagsByName`).
    if (resolvedFields.tags.length > 0) {
      try {
        const tagIds = await findOrCreateTagsByName(db, {
          accountId: automation.account_id,
          userId: automation.user_id,
          names: resolvedFields.tags,
        })
        for (const tagId of tagIds) {
          await addContactTagIfAbsent(db, {
            accountId: automation.account_id,
            contactId: resolved.contactId,
            tagId,
          }).catch((err) => {
            console.error('[hooks] failed to attach tag to contact:', err)
          })
        }
      } catch (err) {
        console.error('[hooks] tag resolution failed:', err)
      }
    }

    // Mapped custom fields (this account's own user-defined fields —
    // Order ID, Lead Source, whatever) are written onto the contact the
    // same way `email`/`company` are, via the shared, ownership-checked
    // helper. Best-effort, same as tags above: never blocks the
    // automation itself from running.
    if (Object.keys(resolvedFields.customFields).length > 0) {
      await upsertContactCustomValues(db, {
        accountId: automation.account_id,
        contactId: resolved.contactId,
        values: resolvedFields.customFields,
      }).catch((err) => {
        console.error('[hooks] custom field write failed:', err)
      })
    }

    // Also exposed as `{{vars.tags}}` (comma-joined) so a step can
    // still branch on the raw tag list explicitly (e.g. a Condition
    // step), independent of whatever CRM tags were just attached
    // above. An explicit `vars.tags` from the mapping's own `vars`
    // list wins if the user configured both.
    const vars = { ...resolvedFields.vars }
    if (resolvedFields.tags.length > 0 && !('tags' in vars)) {
      vars.tags = resolvedFields.tags.join(', ')
    }

    // Fire-and-forget from the caller's point of view — the external
    // system just wants a 200 to know the lead/order was received; the
    // automation's own steps (which can include a WhatsApp send) run
    // through the same engine + logging every other trigger uses.
    // Awaited (not detached) so a step failure is at least reflected in
    // automation_logs before this handler returns, matching how the
    // WhatsApp webhook route treats its own automation dispatch.
    await runAutomationsForTrigger({
      accountId: automation.account_id,
      triggerType: 'incoming_webhook',
      contactId: resolved.contactId,
      context: { webhook_token: token, vars },
    }).catch((err) => {
      console.error('[hooks] automation dispatch failed:', err)
    })

    return ok(
      {
        contact_id: resolved.contactId,
        contact_created: resolved.contactCreated,
        automation_ran: true,
      },
      200,
    )
  } catch (err) {
    return toApiErrorResponse(err)
  }
}