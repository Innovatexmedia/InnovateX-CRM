import { NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

/**
 * Landing route for every emailed Supabase auth link (password reset,
 * signup confirmation, …).
 *
 * Two link shapes are handled:
 *   - `?code=…`                (PKCE — Supabase's default). The code can
 *     only be exchanged in the SAME browser that requested the email,
 *     because the PKCE verifier lives in that browser's cookies.
 *   - `?token_hash=…&type=…`   (custom email template). Works in any
 *     browser or device — use it if people open mails on their phone.
 *
 * When a link can't be used, the person used to be dropped on /login
 * with an `?error=` the login page never displayed, so it just looked
 * like the reset link "opened the login page". Failures now carry a
 * readable message, and a failed password-reset goes back to
 * /forgot-password so a fresh link can be requested right away.
 */

const RESET_PATH = '/reset-password'

const OTP_TYPES: readonly EmailOtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
]

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value)
}

/** Same-origin paths only: "/x" is fine, "//evil.com" and "x" are not. */
function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/dashboard'
  return next
}

function failure(origin: string, next: string, reason: 'expired' | 'verifier' | 'incomplete') {
  const isReset = next.startsWith(RESET_PATH)

  // A dead reset link is most useful on the page that can send another,
  // so the copy points at the form right below the message.
  const message = isReset
    ? reason === 'verifier'
      ? 'This reset link can only be opened in the browser where it was requested. Enter your email below to get a new link.'
      : reason === 'incomplete'
        ? 'This reset link is incomplete. Enter your email below to get a new one.'
        : 'This reset link has expired or has already been used. Enter your email below to get a new one.'
    : 'This link has expired or has already been used. Please sign in, or request a new link.'

  const target = isReset ? '/forgot-password' : '/login'
  return NextResponse.redirect(`${origin}${target}?error=${encodeURIComponent(message)}`)
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  // A recovery link always ends on the set-new-password page. Don't leave
  // that to the `next` param: if a mail client or link tracker drops it,
  // the person is silently signed in and dropped on /dashboard instead.
  const next = type === 'recovery' ? RESET_PATH : safeNextPath(searchParams.get('next'))

  // Supabase redirects here with `error` / `error_code` instead of a
  // code when it already rejected the link (typically `otp_expired`: the
  // link was opened once before — e.g. by a mail scanner — or timed out).
  if (searchParams.get('error') || searchParams.get('error_code')) {
    return failure(origin, next, 'expired')
  }

  const supabase = await createClient()

  if (tokenHash && isOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (error) return failure(origin, next, 'expired')
    return NextResponse.redirect(`${origin}${next}`)
  }

  if (!code) {
    return failure(origin, next, 'incomplete')
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return failure(origin, next, /code verifier/i.test(error.message) ? 'verifier' : 'expired')
  }

  return NextResponse.redirect(`${origin}${next}`)
}