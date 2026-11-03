/**
 * Server-only helpers for WhatsApp Embedded Signup. Imports `node:crypto`
 * and reads secrets from the environment — never import this from a
 * client component (use `./embedded-signup` for the shared parts).
 */

import crypto from 'node:crypto'

export interface EmbeddedSignupServerEnv {
  appId: string
  appSecret: string
}

/**
 * The Tech Provider Meta App used for the "Connect with Facebook" popup.
 *
 *   NEXT_PUBLIC_META_ES_APP_ID    — App ID (also read by the browser).
 *   META_ES_APP_SECRET            — that app's App Secret (server only).
 *   NEXT_PUBLIC_META_ES_CONFIG_ID — Facebook Login for Business
 *                                   configuration id (browser only; see
 *                                   the settings component).
 *
 * Dedicated variables (rather than reusing META_APP_ID / META_APP_SECRET)
 * because those can hold a different app — META_APP_SECRET may even list
 * several comma-separated secrets for the webhook — and mixing them up
 * would exchange the popup's code against the wrong app.
 *
 * Returns null when Embedded Signup is not configured; callers answer
 * 503 and the settings page hides the button.
 */
export function getEmbeddedSignupServerEnv(
  env: Record<string, string | undefined> = process.env,
): EmbeddedSignupServerEnv | null {
  const appId = (env.NEXT_PUBLIC_META_ES_APP_ID ?? '').trim()
  const appSecret = (env.META_ES_APP_SECRET ?? '').trim()
  if (!/^\d+$/.test(appId) || !appSecret) return null
  return { appId, appSecret }
}

/**
 * A random 6-digit two-step-verification PIN. Embedded Signup numbers
 * are registered with the Cloud API using a PIN WE choose (the client
 * never sees or needs it); it is stored encrypted so a later
 * re-register can reuse it.
 */
export function generateRegistrationPin(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}