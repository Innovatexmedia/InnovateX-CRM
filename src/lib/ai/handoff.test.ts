import { describe, it, expect } from 'vitest'
import {
  buildHandoffSummary,
  buildAgentAssignedNotice,
  isValidHandoffNotice,
  sanitizeAgentName,
} from './handoff'

describe('buildHandoffSummary', () => {
  it('notes the reply count and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    })
    expect(summary).toBe(
      '🤖 AI agent handed off after 2 replies. Last customer message: “I want a refund”',
    )
  })

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'help' }],
      replyCount: 1,
    })
    expect(summary).toContain('after 1 reply.')
  })

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    })
    expect(summary).toContain('handed off without replying.')
    expect(summary).toContain('“agent please”')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    })
    expect(summary).toContain('“second”')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    })
    expect(summary).toContain('…')
    // 160-char cap on the quote; the whole note stays well under 250.
    expect(summary.length).toBeLessThan(250)
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    })
    expect(summary).toBe('🤖 AI agent handed off without replying.')
  })
})

describe('buildHandoffSummary — reason', () => {
  const messages = [{ role: 'user' as const, content: 'agent please' }]

  it('adds a reason sentence only when one is given (default wording unchanged)', () => {
    expect(buildHandoffSummary({ messages, replyCount: 0 })).not.toContain('Reason:')
    const s = buildHandoffSummary({ messages, replyCount: 2, reason: 'customer_request' })
    expect(s).toContain('after 2 replies. Reason: the customer asked for a human.')
    expect(s).toContain('“agent please”')
  })

  it('has distinct wording for cap and burst', () => {
    expect(buildHandoffSummary({ messages, replyCount: 5, reason: 'cap' })).toContain(
      'reply limit was reached',
    )
    expect(buildHandoffSummary({ messages, replyCount: 5, reason: 'burst' })).toContain(
      'possible bot loop',
    )
  })
})

describe('buildHandoffSummary — error reason', () => {
  it('records the AI failure and its code for whoever picks the chat up', () => {
    const s = buildHandoffSummary({
      messages: [{ role: 'user', content: 'price?' }],
      replyCount: 0,
      reason: 'error',
      detail: 'invalid_key',
    })
    expect(s).toContain('AI service was unavailable')
    expect(s).toContain('[invalid_key]')
  })
})

describe('sanitizeAgentName', () => {
  it('trims, collapses whitespace and strips control characters', () => {
    expect(sanitizeAgentName('  Riya\n\tSharma  ')).toBe('Riya Sharma')
    expect(sanitizeAgentName('Ri\u0000ya')).toBe('Ri ya')
  })

  it('caps very long names', () => {
    expect(sanitizeAgentName('A'.repeat(200))?.length).toBe(60)
  })

  it('returns null for blank / missing names', () => {
    for (const v of [null, undefined, '', '   ', '\n\t']) {
      expect(sanitizeAgentName(v)).toBeNull()
    }
  })
})

describe('buildAgentAssignedNotice', () => {
  it('names the agent', () => {
    expect(buildAgentAssignedNotice('Riya Sharma')).toBe(
      "I've assigned Riya Sharma to your chat. They'll reply here shortly.",
    )
  })

  it('sanitises the name it prints', () => {
    expect(buildAgentAssignedNotice('  Riya \n Sharma ')).toContain('assigned Riya Sharma to')
  })

  it('tells the customer the team has the chat when there is no agent name', () => {
    for (const blank of [null, undefined, '', '   ']) {
      expect(buildAgentAssignedNotice(blank)).toBe(
        "I've passed your chat to our team. Someone will reply here shortly.",
      )
    }
  })
})

describe('isValidHandoffNotice', () => {
  it('accepts a short notice that names the agent (case-insensitive)', () => {
    expect(isValidHandoffNotice('riya sharma ko aapki chat assign kar di gayi hai', 'Riya Sharma')).toBe(true)
  })

  it('rejects empty, missing-name, over-long or marker-containing text', () => {
    expect(isValidHandoffNotice('', 'Riya')).toBe(false)
    expect(isValidHandoffNotice(null, 'Riya')).toBe(false)
    expect(isValidHandoffNotice('Someone will help you soon.', 'Riya')).toBe(false)
    expect(isValidHandoffNotice('Riya ' + 'x'.repeat(400), 'Riya')).toBe(false)
    expect(isValidHandoffNotice('Riya assigned [[HANDOFF]]', 'Riya')).toBe(false)
  })
})