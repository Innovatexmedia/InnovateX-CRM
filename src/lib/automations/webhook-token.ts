import { randomBytes } from 'crypto'

/**
 * Generate a fresh token for an `incoming_webhook` trigger.
 *
 * 24 random bytes → 32 URL-safe base64 characters (192 bits of
 * entropy) — unguessable, and short enough to sit comfortably in a
 * URL path segment that a non-technical user will copy/paste into
 * Zapier, Shopify, or a landing-page form handler.
 *
 * Callers (the automations POST/PATCH routes) MUST generate this
 * server-side and never accept a client-supplied token — see the
 * comment on `IncomingWebhookTriggerConfig`.
 */
export function generateWebhookToken(): string {
  return randomBytes(24).toString('base64url')
}