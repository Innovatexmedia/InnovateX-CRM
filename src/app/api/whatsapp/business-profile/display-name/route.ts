import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  getPhoneNumberExtras,
  requestDisplayNameChange,
} from '@/lib/whatsapp/meta-api'
import {
  ProfileRequestError,
  loadWhatsAppCreds,
  profileErrorResponse,
} from '@/lib/whatsapp/business-profile-server'

/**
 * POST /api/whatsapp/business-profile/display-name  { name }
 *
 * Submits a new display name for Meta's review. Meta keeps the current
 * name live until the new one is approved, so this is safe to call; the
 * response carries the review status so the card can show "Pending".
 * Admin+ only — it changes how the business is named to customers.
 */
const MIN_NAME = 3
const MAX_NAME = 100

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    let body: { name?: unknown }
    try {
      body = (await request.json()) as { name?: unknown }
    } catch {
      throw new ProfileRequestError('Invalid JSON body.', 400)
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.length < MIN_NAME) {
      throw new ProfileRequestError(
        `The display name must be at least ${MIN_NAME} characters.`,
        400,
      )
    }
    if (name.length > MAX_NAME) {
      throw new ProfileRequestError(
        `The display name must be ${MAX_NAME} characters or fewer.`,
        400,
      )
    }

    const creds = await loadWhatsAppCreds(supabase, accountId)
    await requestDisplayNameChange({
      phoneNumberId: creds.phoneNumberId,
      accessToken: creds.accessToken,
      newDisplayName: name,
    })

    const extras = await getPhoneNumberExtras({
      phoneNumberId: creds.phoneNumberId,
      accessToken: creds.accessToken,
      fields: ['name_status', 'new_display_name', 'new_name_status'],
    })
    return NextResponse.json({
      success: true,
      number: {
        name_status: extras.name_status ?? null,
        new_display_name: extras.new_display_name ?? name,
        new_name_status: extras.new_name_status ?? 'PENDING_REVIEW',
      },
    })
  } catch (err) {
    return profileErrorResponse(err, 'display name change')
  }
}