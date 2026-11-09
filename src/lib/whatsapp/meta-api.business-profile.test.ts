import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getBusinessProfile,
  getPhoneNumberExtras,
  requestDisplayNameChange,
  updateBusinessProfile,
} from './meta-api'

const calls: Array<{ url: string; init?: RequestInit }> = []

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response
}

describe('business profile Meta helpers', () => {
  beforeEach(() => {
    calls.length = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getBusinessProfile returns the first entry of data[]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({
          data: [{ about: 'Hi', vertical: 'EDU', websites: ['https://a.in'] }],
        })
      }),
    )
    const p = await getBusinessProfile({ phoneNumberId: '111', accessToken: 'tok' })
    expect(p.about).toBe('Hi')
    expect(p.vertical).toBe('EDU')
    expect(calls[0].url).toContain('/111/whatsapp_business_profile?fields=')
    expect(calls[0].url).toContain('profile_picture_url')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    )
  })

  it('getBusinessProfile returns {} when Meta sends no entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [] })))
    expect(
      await getBusinessProfile({ phoneNumberId: '111', accessToken: 'tok' }),
    ).toEqual({})
  })

  it('updateBusinessProfile posts messaging_product plus only the given fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({ success: true })
      }),
    )
    await updateBusinessProfile({
      phoneNumberId: '111',
      accessToken: 'tok',
      fields: { profile_picture_handle: 'h:1' },
    })
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      messaging_product: 'whatsapp',
      profile_picture_handle: 'h:1',
    })
  })

  it('updateBusinessProfile throws Meta errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { message: '(#100) Invalid parameter', code: 100 } }, false, 400),
      ),
    )
    await expect(
      updateBusinessProfile({
        phoneNumberId: '111',
        accessToken: 'tok',
        fields: { about: 'x' },
      }),
    ).rejects.toThrow('Invalid parameter')
  })

  it('getPhoneNumberExtras returns only string fields that came back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ id: '111', messaging_limit_tier: 'TIER_1K', name_status: 7 }),
      ),
    )
    const x = await getPhoneNumberExtras({
      phoneNumberId: '111',
      accessToken: 'tok',
      fields: ['messaging_limit_tier', 'name_status'],
    })
    expect(x).toEqual({ messaging_limit_tier: 'TIER_1K' })
  })

  it('getPhoneNumberExtras never throws — a failed call yields {}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'nope' } }, false, 400)),
    )
    expect(
      await getPhoneNumberExtras({
        phoneNumberId: '111',
        accessToken: 'tok',
        fields: ['messaging_limit_tier'],
      }),
    ).toEqual({})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(
      await getPhoneNumberExtras({
        phoneNumberId: '111',
        accessToken: 'tok',
        fields: ['messaging_limit_tier'],
      }),
    ).toEqual({})
  })

  it('requestDisplayNameChange posts new_display_name to the phone number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return jsonResponse({ success: true })
      }),
    )
    await requestDisplayNameChange({
      phoneNumberId: '111',
      accessToken: 'tok',
      newDisplayName: 'Acme Traders',
    })
    expect(calls[0].url.endsWith('/111')).toBe(true)
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      new_display_name: 'Acme Traders',
    })
  })
})