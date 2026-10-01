import { describe, it, expect, vi } from 'vitest'
import { findOrCreateTagsByName } from './tag-find-or-create'

/** Minimal fake of the one Supabase chain this module uses:
 *  `.from('tags').select(...).eq(...)` (lookup) and
 *  `.from('tags').insert(...).select(...)` (create). */
function fakeDb(opts: {
  existing: { id: string; name: string }[]
  created?: { id: string; name: string }[]
}) {
  const insertedNames: string[] = []
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: opts.existing, error: null })),
      })),
      insert: vi.fn((rows: { name: string }[]) => {
        insertedNames.push(...rows.map((r) => r.name))
        return {
          select: vi.fn(async () => ({
            data: opts.created ?? rows.map((r, i) => ({ id: `new-${i}`, name: r.name })),
            error: null,
          })),
        }
      }),
    })),
  }
  return { db: db as unknown as Parameters<typeof findOrCreateTagsByName>[0], insertedNames }
}

describe('findOrCreateTagsByName', () => {
  it('returns an empty list for no names', async () => {
    const { db } = fakeDb({ existing: [] })
    const ids = await findOrCreateTagsByName(db, { accountId: 'a', userId: 'u', names: [] })
    expect(ids).toEqual([])
  })

  it('resolves to an existing tag, case-insensitively, without creating one', async () => {
    const { db, insertedNames } = fakeDb({ existing: [{ id: 'tag-1', name: 'Hot' }] })
    const ids = await findOrCreateTagsByName(db, {
      accountId: 'a',
      userId: 'u',
      names: ['hot'],
    })
    expect(ids).toEqual(['tag-1'])
    expect(insertedNames).toEqual([])
  })

  it('creates a tag that does not exist yet', async () => {
    const { db, insertedNames } = fakeDb({ existing: [] })
    const ids = await findOrCreateTagsByName(db, {
      accountId: 'a',
      userId: 'u',
      names: ['bizparadise'],
    })
    expect(insertedNames).toEqual(['bizparadise'])
    expect(ids).toEqual(['new-0'])
  })

  it('dedupes names case-insensitively, keeping the first-seen casing', async () => {
    const { db, insertedNames } = fakeDb({ existing: [] })
    const ids = await findOrCreateTagsByName(db, {
      accountId: 'a',
      userId: 'u',
      names: ['Hot', 'hot', 'HOT'],
    })
    expect(insertedNames).toEqual(['Hot'])
    expect(ids).toEqual(['new-0'])
  })

  it('mixes existing and newly created tags in the result', async () => {
    const { db, insertedNames } = fakeDb({ existing: [{ id: 'tag-1', name: 'Hot' }] })
    const ids = await findOrCreateTagsByName(db, {
      accountId: 'a',
      userId: 'u',
      names: ['hot', 'bizparadise'],
    })
    expect(insertedNames).toEqual(['bizparadise'])
    expect(ids).toEqual(['tag-1', 'new-0'])
  })
})