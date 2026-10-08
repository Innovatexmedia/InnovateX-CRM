import { describe, it, expect } from 'vitest'
import { MetaApiError, describeMetaError } from './meta-api'

const err = (
  extra: Partial<ConstructorParameters<typeof MetaApiError>[1]> = {},
  message = '(#100) Invalid parameter',
) => new MetaApiError(message, { code: 100, httpStatus: 400, ...extra })

describe('describeMetaError', () => {
  it("leads with Meta's own explanation when the message is generic", () => {
    const e = err({
      subcode: 2388299,
      userTitle: 'Variables can’t be at the start or end of the template',
      userMessage: 'Move the variable so it isn’t first or last, then submit again.',
    })
    expect(describeMetaError(e, 'x')).toBe(
      'Variables can’t be at the start or end of the template: Move the variable so it isn’t first or last, then submit again. ((#100) Invalid parameter)',
    )
  })

  it('falls back to error_data.details', () => {
    expect(describeMetaError(err({ details: 'Parameter value is not valid' }), 'x')).toBe(
      'Parameter value is not valid ((#100) Invalid parameter)',
    )
  })

  it('explains a known template subcode when Meta sent no text', () => {
    expect(describeMetaError(err({ subcode: 2388293 }), 'x')).toMatch(/^Too many variables/)
    expect(describeMetaError(err({ subcode: 2388299 }), 'x')).toMatch(/start or end/)
  })

  it('explains known send-time codes', () => {
    expect(describeMetaError(err({ code: 132000 }, '(#132000) Number of parameters does not match'), 'x')).toMatch(
      /^The number of variable values/,
    )
  })

  it("keeps the plain message when there's nothing more, and never repeats text", () => {
    expect(describeMetaError(err(), 'x')).toBe('(#100) Invalid parameter')
    expect(describeMetaError(err({ userTitle: 'Invalid parameter' }), 'x')).toBe('(#100) Invalid parameter')
  })

  it('handles non-Meta errors and non-errors', () => {
    expect(describeMetaError(new Error('boom'), 'x')).toBe('boom')
    expect(describeMetaError('nope', 'fallback')).toBe('fallback')
  })
})