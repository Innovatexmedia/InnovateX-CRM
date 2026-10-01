import { describe, it, expect, vi } from 'vitest'
import { upsertContactCustomValues } from './custom-field-write'

/** Minimal fake of the two Supabase chains this module uses:
 *  `.from('custom_fields').select(...).eq(...).in(...)` (ownership
 *  lookup) and `.from('contact_custom_values').upsert(...)`. */
function fakeDb(opts: { owned: { id: string }[] }) {
  const upserted: { contact_id: string; custom_field_id: string; value: string }[] = []
  const db = {
    from: vi.fn((table: string) => {
      if (table === 'custom_fields') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(async () => ({ data: opts.owned, error: null })),
            })),
          })),
        }
      }
      if (table === 'contact_custom_values') {
        return {
          upsert: vi.fn(async (row: typeof upserted[number]) => {
            upserted.push(row)
            return { error: null }
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
  return { db: db as unknown as Parameters<typeof upsertContactCustomValues>[0], upserted }
}

describe('upsertContactCustomValues', () => {
  it('does nothing for an empty values map', async () => {
    const { db, upserted } = fakeDb({ owned: [] })
    await upsertContactCustomValues(db, { accountId: 'a', contactId: 'c', values: {} })
    expect(upserted).toEqual([])
  })

  it('upserts a value for a field owned by the account', async () => {
    const { db, upserted } = fakeDb({ owned: [{ id: 'field-1' }] })
    await upsertContactCustomValues(db, {
      accountId: 'a',
      contactId: 'c',
      values: { 'field-1': 'Acme Inc' },
    })
    expect(upserted).toEqual([{ contact_id: 'c', custom_field_id: 'field-1', value: 'Acme Inc' }])
  })

  it('silently skips a field id that does not belong to this account', async () => {
    const { db, upserted } = fakeDb({ owned: [] })
    await upsertContactCustomValues(db, {
      accountId: 'a',
      contactId: 'c',
      values: { 'someone-elses-field': 'leaked?' },
    })
    expect(upserted).toEqual([])
  })

  it('writes only the owned subset when some ids are unowned', async () => {
    const { db, upserted } = fakeDb({ owned: [{ id: 'field-1' }] })
    await upsertContactCustomValues(db, {
      accountId: 'a',
      contactId: 'c',
      values: { 'field-1': 'ok', 'field-2': 'nope' },
    })
    expect(upserted).toEqual([{ contact_id: 'c', custom_field_id: 'field-1', value: 'ok' }])
  })

  it('ignores an entry whose key is blank', async () => {
    const { db, upserted } = fakeDb({ owned: [{ id: '' }] })
    await upsertContactCustomValues(db, { accountId: 'a', contactId: 'c', values: { '': 'x' } })
    expect(upserted).toEqual([])
  })
})