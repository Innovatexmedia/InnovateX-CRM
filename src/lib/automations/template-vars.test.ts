import { describe, expect, it } from 'vitest'
import { renderTemplateValue, resolveTemplateParams } from './template-vars'

const ctx = {
  contact: { name: 'Rahul', phone: '+919876543210', email: null, company: 'Acme' },
  vars: { order_id: 'A-17', n: 5 },
  messageText: 'hello',
}

describe('renderTemplateValue', () => {
  it('renders contact, vars and message tokens', () => {
    expect(renderTemplateValue('{{ contact.name }}', ctx)).toBe('Rahul')
    expect(renderTemplateValue('{{contact.phone}}', ctx)).toBe('+919876543210')
    expect(renderTemplateValue('#{{ vars.order_id }}', ctx)).toBe('#A-17')
    expect(renderTemplateValue('{{ vars.n }}', ctx)).toBe('5')
    expect(renderTemplateValue('{{ message.text }}', ctx)).toBe('hello')
  })

  it('renders unknown / null tokens as empty', () => {
    expect(renderTemplateValue('{{ contact.email }}', ctx)).toBe('')
    expect(renderTemplateValue('{{ vars.nope }}', ctx)).toBe('')
    expect(renderTemplateValue('{{ nonsense }}', ctx)).toBe('')
  })

  it('keeps literal text', () => {
    expect(renderTemplateValue('Friday 7pm', ctx)).toBe('Friday 7pm')
  })
})

describe('resolveTemplateParams', () => {
  it('returns [] when the step has no variables', () => {
    expect(resolveTemplateParams(undefined, undefined, ctx)).toEqual([])
  })

  it('orders numerically, not lexicographically', () => {
    const vars: Record<string, string> = {}
    for (let i = 1; i <= 11; i++) vars[String(i)] = `v${i}`
    expect(resolveTemplateParams(vars, undefined, ctx).slice(0, 3)).toEqual(['v1', 'v2', 'v3'])
    expect(resolveTemplateParams(vars, undefined, ctx)[10]).toBe('v11')
  })

  it('uses the fallback when the value renders blank', () => {
    expect(
      resolveTemplateParams(
        { '1': '{{ contact.email }}' },
        { '1': 'there' },
        ctx,
      ),
    ).toEqual(['there'])
  })

  it('prefers the real value over the fallback', () => {
    expect(
      resolveTemplateParams({ '1': '{{ contact.name }}' }, { '1': 'there' }, ctx),
    ).toEqual(['Rahul'])
  })

  it('fails with a clear message when value and fallback are both blank', () => {
    expect(() =>
      resolveTemplateParams({ '1': '{{ contact.email }}' }, undefined, ctx),
    ).toThrow(/Template variable \{\{1\}\} is empty/)
  })

  it('treats a whitespace-only fallback as missing', () => {
    expect(() =>
      resolveTemplateParams({ '1': '{{ contact.email }}' }, { '1': '   ' }, ctx),
    ).toThrow(/empty for this contact/)
  })

  it('flattens newlines and long space runs (Meta rejects them)', () => {
    expect(resolveTemplateParams({ '1': 'a\nb\tc      d' }, undefined, ctx)).toEqual([
      'a b c   d',
    ])
  })
})