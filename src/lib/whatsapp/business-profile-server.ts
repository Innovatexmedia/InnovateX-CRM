import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaApiError, describeMetaError } from '@/lib/whatsapp/meta-api'

/**
 * Server-only helpers shared by the business-profile API routes: load the
 * caller's WhatsApp credentials (account-scoped, token decrypted here and
 * never sent to the browser) and turn any failure into a JSON response.
 */

/** A failure with a ready-to-show message and the HTTP status to send. */
export class ProfileRequestError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ProfileRequestError'
    this.status = status
  }
}

export interface WhatsAppCreds {
  phoneNumberId: string
  accessToken: string
  /** App that issued the token — needed for the profile-photo upload. */
  appId: string
}

export async function loadWhatsAppCreds(
  supabase: SupabaseClient,
  accountId: string,
): Promise<WhatsAppCreds> {
  const { data: config, error } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, access_token, app_id')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !config?.phone_number_id || !config.access_token) {
    throw new ProfileRequestError(
      'WhatsApp is not connected. Connect a number in Settings first.',
      400,
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    throw new ProfileRequestError(
      'The stored access token cannot be decrypted. Reset the WhatsApp configuration and connect again.',
      400,
    )
  }

  return {
    phoneNumberId: config.phone_number_id,
    accessToken,
    // Accounts connected through Facebook (or with their own Meta app)
    // store the issuing app; everyone else uses the deployment app.
    appId: config.app_id || process.env.META_APP_ID || '',
  }
}

/** Meta says the token may not touch this edge (missing permission). */
function isPermissionError(err: MetaApiError): boolean {
  return err.code === 200 || err.code === 10 || /permission/i.test(err.message)
}

/** Map any thrown value to a JSON error response for these routes. */
export function profileErrorResponse(
  err: unknown,
  logLabel: string,
): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  if (err instanceof ProfileRequestError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  if (err instanceof MetaApiError) {
    console.error(`[whatsapp/business-profile] ${logLabel} failed:`, err.message, {
      code: err.code,
      subcode: err.subcode,
      fbtrace_id: err.fbtraceId,
    })
    let message = describeMetaError(err, 'Meta rejected the request.')
    if (isPermissionError(err)) {
      message +=
        ' — this WhatsApp connection does not have permission to manage the business profile (whatsapp_business_management).'
    }
    // Meta answered 4xx → the input/permission is at fault (400); anything
    // else is Meta being unavailable (502).
    const status = err.httpStatus >= 400 && err.httpStatus < 500 ? 400 : 502
    return NextResponse.json(
      { error: message, meta: { code: err.code, fbtrace_id: err.fbtraceId } },
      { status },
    )
  }
  console.error(`[whatsapp/business-profile] ${logLabel} error:`, err)
  return NextResponse.json(
    { error: err instanceof Error ? err.message : 'Internal server error' },
    { status: 500 },
  )
}