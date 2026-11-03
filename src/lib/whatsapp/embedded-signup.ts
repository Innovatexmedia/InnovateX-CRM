/**
 * Shared (browser + server) helpers for WhatsApp Embedded Signup — the
 * "Connect with Facebook" flow.
 *
 * Kept free of Node-only imports on purpose: the same parsing code runs
 * in the settings page (reading Meta's popup `postMessage`) and in the
 * API route (validating what the page posts back).
 *
 * Meta's contract (Embedded Signup v4):
 *   1. The page calls `FB.login({ config_id, response_type: 'code',
 *      override_default_response_type: true, extras: { setup: {} } })`.
 *   2. While the popup runs it posts `WA_EMBEDDED_SIGNUP` messages to
 *      the opener. On completion one carries `{ phone_number_id,
 *      waba_id, business_id }`.
 *   3. `FB.login`'s callback hands back a short-lived (~30 s),
 *      single-use `code` that the SERVER exchanges for a business token.
 */

import { isNumericMetaId } from './waba-pairing'

/** Graph version passed to `FB.init`. Server-side calls use the
 *  version pinned in `meta-api.ts`. */
export const FB_SDK_VERSION = 'v26.0'

/** `event` values Meta sends when the customer finished the flow. */
const FINISH_EVENTS = new Set([
  'FINISH',
  // The customer onboarded an existing WhatsApp Business app number
  // (coexistence). Meta registers it itself — we must NOT call
  // /register for these.
  'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
])

/** Finished events for which the number is already live on Meta's side,
 *  so `/register` (and a PIN) is skipped. */
export const SKIP_REGISTER_EVENTS: ReadonlySet<string> = new Set([
  'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
])

export interface EmbeddedSignupSession {
  phoneNumberId: string
  wabaId: string
  businessId: string | null
  /** Meta's `event` value, e.g. `FINISH`. */
  event: string
}

export type EmbeddedSignupMessage =
  | { kind: 'finish'; session: EmbeddedSignupSession }
  /** The flow ended without a usable phone number (e.g. only a WABA was
   *  created, or API access was granted without adding a number). */
  | { kind: 'incomplete'; event: string }
  | { kind: 'cancel'; step: string | null; errorMessage: string | null }

/**
 * Meta posts from facebook.com (and sub-domains such as
 * business.facebook.com / web.facebook.com). Anything else is ignored so
 * an arbitrary page can't feed us a forged session.
 */
export function isFacebookOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    return protocol === 'https:' && (hostname === 'facebook.com' || hostname.endsWith('.facebook.com'))
  } catch {
    return false
  }
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Parse one `message` event payload from the Embedded Signup popup.
 * `raw` is `event.data` — a JSON string in practice, but an object is
 * accepted too. Returns null for anything that isn't a
 * `WA_EMBEDDED_SIGNUP` message (the popup also posts unrelated events).
 */
export function parseEmbeddedSignupMessage(raw: unknown): EmbeddedSignupMessage | null {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!data || typeof data !== 'object') return null
  const msg = data as { type?: unknown; event?: unknown; data?: unknown }
  if (msg.type !== 'WA_EMBEDDED_SIGNUP') return null

  const event = typeof msg.event === 'string' ? msg.event : ''
  const payload = (msg.data && typeof msg.data === 'object' ? msg.data : {}) as Record<string, unknown>

  if (event === 'CANCEL' || event === 'ERROR') {
    return {
      kind: 'cancel',
      step: str(payload.current_step),
      errorMessage: str(payload.error_message),
    }
  }

  if (FINISH_EVENTS.has(event)) {
    const phoneNumberId = str(payload.phone_number_id)
    const wabaId = str(payload.waba_id)
    if (phoneNumberId && wabaId) {
      return {
        kind: 'finish',
        session: { phoneNumberId, wabaId, businessId: str(payload.business_id), event },
      }
    }
    return { kind: 'incomplete', event }
  }

  // FINISH_ONLY_WABA, FINISH_GRANT_ONLY_API_ACCESS, … — finished, but
  // no number to connect.
  if (event.startsWith('FINISH')) return { kind: 'incomplete', event }

  return null
}

export interface EmbeddedSignupRequest {
  code: string
  phoneNumberId: string
  wabaId: string
  businessId: string | null
  event: string
}

export type EmbeddedSignupRequestResult =
  | { ok: true; value: EmbeddedSignupRequest }
  | { ok: false; error: string; field: 'code' | 'phone_number_id' | 'waba_id' | 'event' }

/** Validate the JSON body the settings page posts to
 *  `POST /api/whatsapp/embedded-signup`. */
export function parseEmbeddedSignupRequest(body: unknown): EmbeddedSignupRequestResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  const code = typeof b.code === 'string' ? b.code.trim() : ''
  if (!code || code.length > 2048) {
    return { ok: false, error: 'Facebook did not return a login code. Please try again.', field: 'code' }
  }
  if (!isNumericMetaId(b.phone_number_id)) {
    return {
      ok: false,
      error: 'Facebook did not return a phone number. Complete every step of the popup and try again.',
      field: 'phone_number_id',
    }
  }
  if (!isNumericMetaId(b.waba_id)) {
    return {
      ok: false,
      error: 'Facebook did not return a WhatsApp Business Account. Complete every step of the popup and try again.',
      field: 'waba_id',
    }
  }

  const event = typeof b.event === 'string' && b.event.trim() ? b.event.trim() : 'FINISH'
  if (!/^[A-Z_]{1,64}$/.test(event) || !event.startsWith('FINISH')) {
    return { ok: false, error: 'Unexpected Embedded Signup event.', field: 'event' }
  }

  const businessId = isNumericMetaId(b.business_id) ? b.business_id : null

  return {
    ok: true,
    value: { code, phoneNumberId: b.phone_number_id, wabaId: b.waba_id, businessId, event },
  }
}