import { describe, it, expect } from 'vitest'
import { getByPath, flattenPayloadKeys, resolveWebhookFields } from './webhook-fields'

describe('getByPath', () => {
  it('resolves a top-level key', () => {
    expect(getByPath({ phone: '+1' }, 'phone')).toBe('+1')
  })

  it('resolves a nested path', () => {
    expect(getByPath({ contact: { phone: '+1' } }, 'contact.phone')).toBe('+1')
  })

  it('returns undefined for a missing segment', () => {
    expect(getByPath({ contact: {} }, 'contact.phone')).toBeUndefined()
  })

  it('returns undefined when walking into a non-object', () => {
    expect(getByPath({ contact: 'not an object' }, 'contact.phone')).toBeUndefined()
  })

  it('returns undefined when walking into an array', () => {
    expect(getByPath({ items: [{ sku: 'A' }] }, 'items.sku')).toBeUndefined()
  })

  it('returns undefined for an empty path', () => {
    expect(getByPath({ phone: '+1' }, '')).toBeUndefined()
  })
})

describe('flattenPayloadKeys', () => {
  it('flattens nested objects into dot-paths', () => {
    const fields = flattenPayloadKeys({
      full_name: 'Jane',
      contact: { phone: '+14155550123', country: 'US' },
    })
    const paths = fields.map((f) => f.path).sort()
    expect(paths).toEqual(['contact.country', 'contact.phone', 'full_name'])
  })

  it('treats arrays as leaves rather than indexing into them', () => {
    const fields = flattenPayloadKeys({ tags: ['vip', 'lead'] })
    expect(fields).toEqual([{ path: 'tags', preview: '[2 items]' }])
  })

  it('previews a null/undefined value as an em dash', () => {
    const fields = flattenPayloadKeys({ middle_name: null })
    expect(fields[0].preview).toBe('—')
  })

  it('truncates a long string preview', () => {
    const long = 'x'.repeat(80)
    const fields = flattenPayloadKeys({ notes: long })
    expect(fields[0].preview.length).toBe(41) // 40 chars + ellipsis
    expect(fields[0].preview.endsWith('…')).toBe(true)
  })

  it('stops descending past the depth cap', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } }
    const fields = flattenPayloadKeys(deep)
    expect(fields.some((f) => f.path === 'a.b.c.d')).toBe(false)
  })
})

describe('resolveWebhookFields', () => {
  const body = {
    full_name: 'Jane Doe',
    contact: { phone: '+14155550123' },
    tags: ['vip', 'lead'],
    order: { id: '1042' },
  }

  it('falls back to the legacy fixed shape when no mapping is configured', () => {
    const legacyBody = { phone: '+1', name: 'Jane', vars: { source: 'landing' } }
    const resolved = resolveWebhookFields(legacyBody, undefined)
    expect(resolved).toEqual({
      phone: '+1',
      name: 'Jane',
      email: null,
      company: null,
      tags: [],
      customFields: {},
      vars: { source: 'landing' },
    })
  })

  it('resolves phone/name/tags/vars via dot-path mapping', () => {
    const resolved = resolveWebhookFields(body, {
      phone: 'contact.phone',
      name: 'full_name',
      tags: 'tags',
      vars: { order_id: 'order.id' },
    })
    expect(resolved.phone).toBe('+14155550123')
    expect(resolved.name).toBe('Jane Doe')
    expect(resolved.tags).toEqual(['vip', 'lead'])
    expect(resolved.vars).toEqual({ order_id: '1042' })
  })

  it('resolves email/company via dot-path mapping, distinct from vars', () => {
    const resolved = resolveWebhookFields(
      { ...body, email: 'jane@example.com', org: { name: 'Acme' } },
      { phone: 'contact.phone', email: 'email', company: 'org.name' },
    )
    expect(resolved.email).toBe('jane@example.com')
    expect(resolved.company).toBe('Acme')
    // Not mirrored into vars unless separately mapped there too.
    expect(resolved.vars).toEqual({})
  })

  it('leaves email/company null when not mapped', () => {
    const resolved = resolveWebhookFields(body, { phone: 'contact.phone' })
    expect(resolved.email).toBeNull()
    expect(resolved.company).toBeNull()
  })

  it('returns a null phone when the mapped path does not resolve', () => {
    const resolved = resolveWebhookFields(body, { phone: 'nope.phone' })
    expect(resolved.phone).toBeNull()
  })

  it('splits a comma-separated tags string', () => {
    const resolved = resolveWebhookFields(
      { tags: 'vip, lead ,  ' },
      { phone: 'contact.phone', tags: 'tags' },
    )
    expect(resolved.tags).toEqual(['vip', 'lead'])
  })
})