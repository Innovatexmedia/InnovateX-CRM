import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROFILE,
  displayNameStatusKind,
  messagingLimitCount,
  normalizeProfile,
  profilesEqual,
  validateProfile,
} from './business-profile'

const ok = { ...EMPTY_PROFILE, about: 'Hello' }

describe('validateProfile', () => {
  it('accepts a minimal profile and trims values', () => {
    const r = validateProfile({ ...ok, about: '  Hi  ', websites: ['', ' https://a.com '] })
    expect(r.ok).toBe(true)
    expect(r.value.about).toBe('Hi')
    expect(r.value.websites).toEqual(['https://a.com'])
  })
  it('requires about and enforces its limit', () => {
    expect(validateProfile({ ...ok, about: '  ' }).errors.about?.code).toBe('aboutRequired')
    expect(validateProfile({ ...ok, about: 'x'.repeat(140) }).errors.about).toEqual({ code: 'tooLong', max: 139 })
  })
  it('checks email, websites and counts', () => {
    expect(validateProfile({ ...ok, email: 'nope' }).errors.email?.code).toBe('email')
    expect(validateProfile({ ...ok, websites: ['ftp://x.com'] }).errors.websites?.code).toBe('website')
    expect(validateProfile({ ...ok, websites: ['https://a.com', 'https://b.com', 'https://c.com'] }).errors.websites?.code).toBe('tooMany')
  })
  it('drops an unknown category instead of failing', () => {
    const r = validateProfile({ ...ok, vertical: 'BOGUS' })
    expect(r.ok).toBe(true)
    expect(r.value.vertical).toBe('')
  })
})

describe('helpers', () => {
  it('normalizeProfile fills gaps', () => {
    expect(normalizeProfile(undefined)).toEqual(EMPTY_PROFILE)
    expect(normalizeProfile({ about: 'a', websites: ['https://x.com'] }).websites).toEqual(['https://x.com'])
  })
  it('profilesEqual ignores whitespace', () => {
    expect(profilesEqual(ok, { ...ok, about: ' Hello ' })).toBe(true)
    expect(profilesEqual(ok, { ...ok, address: 'x' })).toBe(false)
  })
  it('messagingLimitCount parses tiers', () => {
    expect(messagingLimitCount('TIER_250')).toBe(250)
    expect(messagingLimitCount('TIER_1K')).toBe(1000)
    expect(messagingLimitCount('TIER_100K')).toBe(100000)
    expect(messagingLimitCount('TIER_UNLIMITED')).toBe('unlimited')
    expect(messagingLimitCount('weird')).toBeNull()
    expect(messagingLimitCount(undefined)).toBeNull()
  })
  it('displayNameStatusKind collapses statuses', () => {
    expect(displayNameStatusKind('APPROVED')).toBe('approved')
    expect(displayNameStatusKind('PENDING_REVIEW')).toBe('pending')
    expect(displayNameStatusKind('DECLINED')).toBe('declined')
    expect(displayNameStatusKind(null)).toBe('none')
  })
})