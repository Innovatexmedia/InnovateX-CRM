import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import {
  getBusinessProfile,
  getPhoneNumberExtras,
  updateBusinessProfile,
  uploadResumableMedia,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import {
  normalizeProfile,
  validateProfile,
  type BusinessProfileFields,
} from '@/lib/whatsapp/business-profile'
import {
  ProfileRequestError,
  loadWhatsAppCreds,
  profileErrorResponse,
  type WhatsAppCreds,
} from '@/lib/whatsapp/business-profile-server'

/**
 * Business profile of the connected WhatsApp number — what customers see
 * on the number's WhatsApp profile. Works for numbers connected through
 * Facebook (Embedded Signup) and manually alike: both store a phone number
 * ID + access token on `whatsapp_config`, which is all Meta needs.
 *
 *   GET  → { profile, number }          any account member
 *   PUT  → { profile }   (JSON fields)  admin+
 *   POST → { profile }   (multipart `photo`) admin+
 *
 * Reads are open to every member (the profile is public information);
 * writes change what customers see, so they need the same admin role as
 * the other WhatsApp settings.
 */

// Vercel caps a serverless request body at 4.5 MB; the browser downsizes
// photos before upload, so this is a safety net rather than a real limit.
const MAX_PHOTO_BYTES = 4 * 1024 * 1024
const PHOTO_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

async function readProfile(creds: WhatsAppCreds) {
  const [raw, phone, extras] = await Promise.all([
    getBusinessProfile(creds),
    verifyPhoneNumber(creds),
    getPhoneNumberExtras({
      ...creds,
      fields: ['name_status', 'new_display_name', 'new_name_status'],
    }),
  ])
  return {
    profile: {
      ...normalizeProfile(raw),
      profile_picture_url: raw.profile_picture_url ?? null,
    },
    number: {
      display_phone_number: phone.display_phone_number,
      verified_name: phone.verified_name ?? null,
      name_status: extras.name_status ?? null,
      new_display_name: extras.new_display_name ?? null,
      new_name_status: extras.new_name_status ?? null,
    },
  }
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const creds = await loadWhatsAppCreds(supabase, accountId)
    return NextResponse.json(await readProfile(creds))
  } catch (err) {
    return profileErrorResponse(err, 'read')
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      throw new ProfileRequestError('Invalid JSON body.', 400)
    }

    const input: BusinessProfileFields = {
      about: asString(body.about),
      description: asString(body.description),
      address: asString(body.address),
      email: asString(body.email),
      vertical: asString(body.vertical),
      websites: Array.isArray(body.websites)
        ? body.websites.filter((w): w is string => typeof w === 'string')
        : [],
    }
    const { ok, errors, value } = validateProfile(input)
    if (!ok) {
      return NextResponse.json(
        { error: 'Please fix the highlighted fields.', fields: errors },
        { status: 400 },
      )
    }

    const creds = await loadWhatsAppCreds(supabase, accountId)
    await updateBusinessProfile({
      ...creds,
      fields: {
        about: value.about,
        description: value.description,
        address: value.address,
        email: value.email,
        websites: value.websites,
        // An empty category is left unchanged rather than sent as ''.
        ...(value.vertical ? { vertical: value.vertical } : {}),
      },
    })

    return NextResponse.json({ profile: (await readProfile(creds)).profile })
  } catch (err) {
    return profileErrorResponse(err, 'update')
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      throw new ProfileRequestError('Expected a multipart form with a "photo" file.', 400)
    }
    const photo = form.get('photo')
    if (!(photo instanceof File)) {
      throw new ProfileRequestError('No photo was uploaded.', 400)
    }
    const mimeType = photo.type.toLowerCase()
    const extension = PHOTO_TYPES[mimeType]
    if (!extension) {
      throw new ProfileRequestError('The profile photo must be a JPG or PNG image.', 400)
    }
    if (photo.size === 0) {
      throw new ProfileRequestError('The uploaded photo is empty.', 400)
    }
    if (photo.size > MAX_PHOTO_BYTES) {
      throw new ProfileRequestError('The profile photo must be 4 MB or smaller.', 400)
    }

    const creds = await loadWhatsAppCreds(supabase, accountId)
    if (!creds.appId) {
      throw new ProfileRequestError(
        'Uploading a profile photo needs a Meta App ID (used for Meta’s Resumable Upload). Set META_APP_ID, or add this account’s own App ID in Settings → WhatsApp.',
        400,
      )
    }

    const bytes = new Uint8Array(await photo.arrayBuffer())
    const { handle } = await uploadResumableMedia({
      appId: creds.appId,
      accessToken: creds.accessToken,
      fileName: `profile.${extension}`,
      mimeType,
      bytes,
    })
    await updateBusinessProfile({
      phoneNumberId: creds.phoneNumberId,
      accessToken: creds.accessToken,
      fields: { profile_picture_handle: handle },
    })

    return NextResponse.json({ profile: (await readProfile(creds)).profile })
  } catch (err) {
    return profileErrorResponse(err, 'photo upload')
  }
}