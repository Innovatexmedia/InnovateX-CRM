/**
 * WhatsApp Business Profile — shared types, limits and validation.
 *
 * Pure (no imports, no I/O) so the settings card (client) and the
 * /api/whatsapp/business-profile route (server) validate against exactly
 * the same rules, and so it is trivially unit-testable.
 *
 * Limits mirror Meta's Cloud API "Business Profiles" reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles
 */

export const PROFILE_LIMITS = {
  /** `about` is required by Meta (1–139 characters). */
  about: 139,
  description: 512,
  address: 256,
  email: 128,
  /** Per website URL. */
  website: 256,
  /** Number of website URLs Meta accepts. */
  websites: 2,
} as const

/** Meta's `vertical` (category) values that can be chosen. */
export const PROFILE_VERTICALS = [
  'AUTO',
  'BEAUTY',
  'APPAREL',
  'EDU',
  'ENTERTAIN',
  'EVENT_PLAN',
  'FINANCE',
  'GROCERY',
  'GOVT',
  'HOTEL',
  'HEALTH',
  'NONPROFIT',
  'PROF_SERVICES',
  'RETAIL',
  'TRAVEL',
  'RESTAURANT',
  'OTHER',
] as const

export type ProfileVertical = (typeof PROFILE_VERTICALS)[number]

/** Editable text fields of a business profile (the profile photo is separate). */
export interface BusinessProfileFields {
  about: string
  description: string
  address: string
  email: string
  /** A {@link ProfileVertical} or '' when none is set. */
  vertical: string
  websites: string[]
}

/** Shape Meta returns for `GET /{phone_number_id}/whatsapp_business_profile`. */
export interface MetaBusinessProfileData {
  about?: string
  address?: string
  description?: string
  email?: string
  profile_picture_url?: string
  websites?: string[]
  vertical?: string
}

export type ProfileFieldName = keyof BusinessProfileFields

export interface ProfileFieldError {
  code: 'aboutRequired' | 'tooLong' | 'email' | 'website' | 'tooMany'
  /** Present for `tooLong` / `tooMany`. */
  max?: number
}

export type ProfileErrors = Partial<Record<ProfileFieldName, ProfileFieldError>>

export const EMPTY_PROFILE: BusinessProfileFields = {
  about: '',
  description: '',
  address: '',
  email: '',
  vertical: '',
  websites: [],
}

/** Meta's raw profile → the editable shape (missing values become ''). */
export function normalizeProfile(
  raw: MetaBusinessProfileData | null | undefined,
): BusinessProfileFields {
  return {
    about: raw?.about ?? '',
    description: raw?.description ?? '',
    address: raw?.address ?? '',
    email: raw?.email ?? '',
    vertical: raw?.vertical ?? '',
    websites: Array.isArray(raw?.websites)
      ? raw.websites.filter((w): w is string => typeof w === 'string')
      : [],
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(value)) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Trim, drop empty website rows, and check every field against Meta's
 * limits. `value` is the cleaned input to send; `errors` is keyed by field
 * so a form can show each message inline. `ok` is true when `errors` is
 * empty.
 */
export function validateProfile(input: BusinessProfileFields): {
  ok: boolean
  errors: ProfileErrors
  value: BusinessProfileFields
} {
  const value: BusinessProfileFields = {
    about: input.about.trim(),
    description: input.description.trim(),
    address: input.address.trim(),
    email: input.email.trim(),
    vertical: input.vertical.trim(),
    websites: input.websites.map((w) => w.trim()).filter((w) => w.length > 0),
  }
  const errors: ProfileErrors = {}

  if (value.about.length === 0) {
    errors.about = { code: 'aboutRequired' }
  } else if (value.about.length > PROFILE_LIMITS.about) {
    errors.about = { code: 'tooLong', max: PROFILE_LIMITS.about }
  }

  if (value.description.length > PROFILE_LIMITS.description) {
    errors.description = { code: 'tooLong', max: PROFILE_LIMITS.description }
  }

  if (value.address.length > PROFILE_LIMITS.address) {
    errors.address = { code: 'tooLong', max: PROFILE_LIMITS.address }
  }

  if (value.email) {
    if (value.email.length > PROFILE_LIMITS.email) {
      errors.email = { code: 'tooLong', max: PROFILE_LIMITS.email }
    } else if (!EMAIL_RE.test(value.email)) {
      errors.email = { code: 'email' }
    }
  }

  if (value.websites.length > PROFILE_LIMITS.websites) {
    errors.websites = { code: 'tooMany', max: PROFILE_LIMITS.websites }
  } else if (
    value.websites.some(
      (w) => w.length > PROFILE_LIMITS.website || !isHttpUrl(w),
    )
  ) {
    errors.websites = { code: 'website' }
  }

  if (
    value.vertical &&
    !(PROFILE_VERTICALS as readonly string[]).includes(value.vertical)
  ) {
    // An unknown category is never user-selectable; treat as unset rather
    // than sending Meta a value it will reject.
    value.vertical = ''
  }

  return { ok: Object.keys(errors).length === 0, errors, value }
}

/** True when two profiles hold the same values (after trimming). */
export function profilesEqual(
  a: BusinessProfileFields,
  b: BusinessProfileFields,
): boolean {
  const na = validateProfile(a).value
  const nb = validateProfile(b).value
  return (
    na.about === nb.about &&
    na.description === nb.description &&
    na.address === nb.address &&
    na.email === nb.email &&
    na.vertical === nb.vertical &&
    na.websites.length === nb.websites.length &&
    na.websites.every((w, i) => w === nb.websites[i])
  )
}

// ------------------------------------------------------------
// Messaging limit + display name status (phone number node)
// ------------------------------------------------------------

/**
 * Meta's `messaging_limit_tier` (`TIER_50`, `TIER_250`, `TIER_1K`,
 * `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED`) as a number of customers per
 * 24 hours, `'unlimited'`, or null when absent/unrecognised.
 */
export function messagingLimitCount(
  tier: string | null | undefined,
): number | 'unlimited' | null {
  if (!tier) return null
  const t = tier.trim().toUpperCase()
  if (t === 'TIER_UNLIMITED') return 'unlimited'
  const m = /^TIER_(\d+)(K|M)?$/.exec(t)
  if (!m) return null
  const base = Number(m[1])
  if (!Number.isFinite(base)) return null
  if (m[2] === 'K') return base * 1_000
  if (m[2] === 'M') return base * 1_000_000
  return base
}

export type DisplayNameStatusKind = 'approved' | 'pending' | 'declined' | 'none'

/** Meta's `name_status` / `new_name_status` collapsed to what the UI shows. */
export function displayNameStatusKind(
  status: string | null | undefined,
): DisplayNameStatusKind {
  switch ((status ?? '').toUpperCase()) {
    case 'APPROVED':
    case 'AVAILABLE_WITHOUT_REVIEW':
      return 'approved'
    case 'PENDING_REVIEW':
      return 'pending'
    case 'DECLINED':
    case 'EXPIRED':
      return 'declined'
    default:
      return 'none'
  }
}