import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendMessageToConversation: vi.fn(async () => ({ messageId: 'm1', whatsappMessageId: 'wamid.1' })),
}))

vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: h.sendMessageToConversation,
}))

import { applyOptKeywordMatch } from './keyword-match'

/** Minimal fake Supabase client covering the tables this module touches. */
function fakeDb(opts: {
  keywords?: Record<string, unknown>[]
  response?: Record<string, unknown> | null
  contactUpdate?: { error: { message: string } | null }
}) {
  const keywords = opts.keywords ?? []
  const response = opts.response ?? null
  const contactUpdates: Record<string, unknown>[] = []

  return {
    contactUpdates,
    from(table: string) {
      if (table === 'opt_keywords') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: keywords, error: null }),
            }),
          }),
        }
      }
      if (table === 'quick_replies') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'contacts') {
        return {
          update: (patch: Record<string, unknown>) => {
            contactUpdates.push(patch)
            return { eq: () => ({ eq: () => Promise.resolve(opts.contactUpdate ?? { error: null }) }) }
          },
        }
      }
      if (table === 'opt_responses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: response, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    // Not used unless response_type === 'template'.
  } as unknown as import('@supabase/supabase-js').SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('applyOptKeywordMatch', () => {
  it('matches a "contains" opt-out keyword and opts the contact out', async () => {
    const db = fakeDb({
      keywords: [
        { id: 'k1', direction: 'out', keyword: 'stop', match_type: 'contains', enabled: true },
      ],
    })

    const result = await applyOptKeywordMatch({
      db,
      accountId: 'acc-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      text: 'please STOP messaging me',
    })

    expect(result).toMatchObject({ matched: true, direction: 'out', via: 'keyword' })
    expect((db as unknown as { contactUpdates: Record<string, unknown>[] }).contactUpdates).toHaveLength(1)
    expect((db as unknown as { contactUpdates: Record<string, unknown>[] }).contactUpdates[0]).toMatchObject({
      subscription_status: 'opted_out',
      opt_source: 'keyword',
    })
  })

  it('requires a full match for an "exact" keyword', async () => {
    const db = fakeDb({
      keywords: [
        { id: 'k1', direction: 'in', keyword: 'start', match_type: 'exact', enabled: true },
      ],
    })

    const noMatch = await applyOptKeywordMatch({
      db,
      accountId: 'acc-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      text: 'please start now',
    })
    expect(noMatch.matched).toBe(false)

    const exactMatch = await applyOptKeywordMatch({
      db,
      accountId: 'acc-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      text: '  START  ',
    })
    expect(exactMatch).toMatchObject({ matched: true, direction: 'in' })
  })

  it('sends the configured response when one is enabled for the matched direction', async () => {
    const db = fakeDb({
      keywords: [
        { id: 'k1', direction: 'in', keyword: 'start', match_type: 'exact', enabled: true },
      ],
      response: {
        direction: 'in',
        enabled: true,
        response_type: 'message',
        message_text: 'Welcome back!',
      },
    })

    await applyOptKeywordMatch({
      db,
      accountId: 'acc-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      text: 'start',
    })

    expect(h.sendMessageToConversation).toHaveBeenCalledWith(
      db,
      'acc-1',
      expect.objectContaining({ conversationId: 'conv-1', messageType: 'text', contentText: 'Welcome back!' }),
    )
  })

  it('returns no match when nothing configured matches the text', async () => {
    const db = fakeDb({ keywords: [] })

    const result = await applyOptKeywordMatch({
      db,
      accountId: 'acc-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      text: 'hello there',
    })

    expect(result).toEqual({ matched: false })
    expect(h.sendMessageToConversation).not.toHaveBeenCalled()
  })
})