import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is **required**. If it's missing we fail closed —
 *   every request is rejected until the operator configures the
 *   secret. A previous version fell open with a warning log, which is
 *   unsafe for a public template: anyone who forgets the env var would
 *   be running a fully spoofable webhook.
 *
 *   It may hold **several** secrets separated by commas (issue #500).
 *   Each Meta App signs with its own secret, so one deployment that
 *   receives webhooks from WABAs living under different Meta Apps needs
 *   to accept any of them. A request is valid when its signature
 *   matches ANY configured secret; each candidate is compared in
 *   constant time. See docs/multi-waba.md.
 *
 *   On top of the env-configured list, a caller may pass `extraSecrets`
 *   — per-account `whatsapp_config.app_secret` values (migration 046).
 *   This lets a new client whose WABA lives under its own Meta App
 *   connect purely from Settings → WhatsApp connection, with no env
 *   var edit or redeploy: they paste their App Secret into the form,
 *   the webhook route decrypts every configured one and passes them
 *   here alongside `META_APP_SECRET`.
 */

/**
 * Split `META_APP_SECRET` into its candidate secrets: comma-separated,
 * whitespace trimmed, empties dropped. Exported for tests and for
 * anything else that wants to know how many apps are configured.
 */
export function parseAppSecrets(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function signatureMatches(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  extraSecrets: string[] = [],
): boolean {
  const secrets = [...parseAppSecrets(process.env.META_APP_SECRET), ...extraSecrets]
  if (secrets.length === 0) {
    console.error(
      '[webhook] No app secret configured — rejecting request. ' +
        'Set META_APP_SECRET (Meta → App Settings → Basic → App Secret), ' +
        'or have at least one account save its own App Secret in ' +
        'Settings → WhatsApp connection, to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  // Deliberately no early return inside the loop's compare: every
  // candidate is checked with timingSafeEqual, and the loop cost is
  // proportional to the number of configured apps (public knowledge
  // from the operator's point of view), not to the secret contents.
  let ok = false
  for (const secret of secrets) {
    if (signatureMatches(rawBody, signatureHeader, secret)) ok = true
  }
  return ok
}