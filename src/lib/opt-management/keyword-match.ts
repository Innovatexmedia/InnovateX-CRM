// ============================================================
// Opt-in / opt-out keyword matching — the webhook-side half of the
// compliance feature (migration 044). Given an inbound text message
// (or a tapped quick-reply button flagged `triggers_opt_in`), decides
// whether it flips the contact's subscription_status and, if the
// account configured one, sends the matching auto-response.
//
// Kept out of the webhook route file itself so it can be unit tested
// in isolation and so the route stays about Meta plumbing, not opt
// rules. Uses the service-role client the webhook already runs under
// (an inbound event has no user session) — every query is scoped by
// accountId, same discipline as the rest of the webhook.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import type { OptDirection, OptKeyword, OptResponse } from '@/types'

export interface OptKeywordMatchInput {
  db: SupabaseClient
  accountId: string
  contactId: string
  conversationId: string
  /** Inbound plain text, if any (a button/list tap has no free text). */
  text?: string | null
  /** Set when this inbound event IS an interactive button/list tap —
   *  the id Meta echoed back, used to resolve a `triggers_opt_in`
   *  quick reply. */
  interactiveReplyId?: string | null
}

export interface OptKeywordMatchResult {
  matched: boolean
  direction?: OptDirection
  /** What triggered it — for logging/tests. */
  via?: 'keyword' | 'quick_reply'
}

function normalize(s: string): string {
  return s.trim().toLowerCase()
}

function keywordMatches(keyword: OptKeyword, text: string): boolean {
  const needle = normalize(keyword.keyword)
  if (!needle) return false
  const haystack = normalize(text)
  return keyword.match_type === 'exact' ? haystack === needle : haystack.includes(needle)
}

/**
 * Resolve whether the tapped interactive button belongs to a quick
 * reply flagged `triggers_opt_in`. Quick replies are account-shared
 * snippets whose interactive payload embeds the button ids Meta
 * echoes back on tap — there's no `quick_reply_id` on the inbound
 * message itself, so we look it up by scanning the (typically very
 * few) trigger-flagged interactive quick replies for this account.
 */
async function interactiveReplyTriggersOptIn(
  db: SupabaseClient,
  accountId: string,
  interactiveReplyId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('quick_replies')
    .select('interactive_payload')
    .eq('account_id', accountId)
    .eq('kind', 'interactive')
    .eq('triggers_opt_in', true)

  if (error || !data) return false

  for (const row of data as { interactive_payload: unknown }[]) {
    const payload = row.interactive_payload as
      | { kind: 'buttons'; buttons: { id: string }[] }
      | { kind: 'list'; sections: { rows: { id: string }[] }[] }
      | null
    if (!payload) continue
    if (payload.kind === 'buttons') {
      if (payload.buttons?.some((b) => b.id === interactiveReplyId)) return true
    } else if (payload.kind === 'list') {
      if (payload.sections?.some((s) => s.rows?.some((r) => r.id === interactiveReplyId))) {
        return true
      }
    }
  }
  return false
}

/**
 * Check an inbound message against the account's opt keywords (and,
 * for an interactive tap, its `triggers_opt_in` quick replies).
 * On a match: updates the contact's subscription_status/opted_*_at/
 * opt_source, and — if the account has an enabled response configured
 * for that direction — sends it. Never throws; the webhook must not
 * fail delivery over an opt-management misconfiguration.
 */
export async function applyOptKeywordMatch(
  input: OptKeywordMatchInput,
): Promise<OptKeywordMatchResult> {
  const { db, accountId, contactId, conversationId, text, interactiveReplyId } = input

  try {
    let direction: OptDirection | null = null
    let via: 'keyword' | 'quick_reply' | undefined

    if (interactiveReplyId) {
      const isOptInTap = await interactiveReplyTriggersOptIn(db, accountId, interactiveReplyId)
      if (isOptInTap) {
        direction = 'in'
        via = 'quick_reply'
      }
    }

    if (!direction && text && text.trim()) {
      const { data: keywords, error } = await db
        .from('opt_keywords')
        .select('*')
        .eq('account_id', accountId)
        .eq('enabled', true)

      if (!error && keywords) {
        const matched = (keywords as OptKeyword[]).find((k) => keywordMatches(k, text))
        if (matched) {
          direction = matched.direction
          via = 'keyword'
        }
      }
    }

    if (!direction) return { matched: false }

    const now = new Date().toISOString()
    const update =
      direction === 'in'
        ? {
            subscription_status: 'opted_in' as const,
            opted_in_at: now,
            opt_source: via === 'quick_reply' ? ('quick_reply' as const) : ('keyword' as const),
            updated_at: now,
          }
        : {
            subscription_status: 'opted_out' as const,
            opted_out_at: now,
            opt_source: 'keyword' as const,
            updated_at: now,
          }

    const { error: updateError } = await db
      .from('contacts')
      .update(update)
      .eq('id', contactId)
      .eq('account_id', accountId)

    if (updateError) {
      console.error('[opt-management] failed to update contact subscription:', updateError)
      return { matched: false }
    }

    await sendConfiguredResponse(db, accountId, conversationId, direction)

    return { matched: true, direction, via }
  } catch (err) {
    console.error('[opt-management] keyword match failed:', err)
    return { matched: false }
  }
}

async function sendConfiguredResponse(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  direction: OptDirection,
): Promise<void> {
  const { data: response, error } = await db
    .from('opt_responses')
    .select('*')
    .eq('account_id', accountId)
    .eq('direction', direction)
    .eq('enabled', true)
    .maybeSingle()

  if (error || !response) return
  const row = response as OptResponse

  try {
    if (row.response_type === 'template' && row.template_id) {
      const { data: template } = await db
        .from('message_templates')
        .select('name, language')
        .eq('id', row.template_id)
        .maybeSingle()
      if (!template?.name) return
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'template',
        templateName: template.name,
        templateLanguage: template.language ?? 'en_US',
      })
    } else if (row.response_type === 'message' && row.message_text?.trim()) {
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'text',
        contentText: row.message_text,
      })
    }
  } catch (err) {
    // Best-effort — the subscription-status change already landed;
    // a failed auto-reply (e.g. the 24h session window closed) must
    // not undo it or block the rest of webhook processing.
    console.error('[opt-management] failed to send configured response:', err)
  }
}