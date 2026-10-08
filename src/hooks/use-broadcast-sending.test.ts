import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({}) }))

import { resolveVariables } from './use-broadcast-sending'
import type { Contact } from '@/types'

const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'c1',
  user_id: 'u1',
  account_id: 'a1',
  name: 'Priya',
  phone: '+919845012873',
  email: '',
  company: '',
  created_at: '',
  updated_at: '',
  ...over,
})

describe('resolveVariables — fallback values', () => {
  it('uses the contact value when it exists', () => {
    expect(
      resolveVariables({ '1': { type: 'field', value: 'name', fallback: 'there' } }, contact()),
    ).toEqual(['Priya'])
  })

  it('uses the fallback when the contact field is empty', () => {
    expect(
      resolveVariables({ '1': { type: 'field', value: 'name', fallback: 'there' } }, contact({ name: '  ' })),
    ).toEqual(['there'])
    expect(
      resolveVariables({ '1': { type: 'field', value: 'email', fallback: 'your inbox' } }, contact()),
    ).toEqual(['your inbox'])
  })

  it('uses the fallback for an empty custom field', () => {
    expect(
      resolveVariables(
        { '1': { type: 'custom_field', value: 'f1', fallback: 'Bengaluru' } },
        contact(),
        new Map([['f1', '']]),
      ),
    ).toEqual(['Bengaluru'])
  })

  it('stays empty without a fallback (the send then fails with a clear error)', () => {
    expect(resolveVariables({ '1': { type: 'field', value: 'email' } }, contact())).toEqual([''])
  })

  it('keeps numeric order for 10+ variables', () => {
    const vars: Record<string, { type: 'static'; value: string }> = {}
    for (let i = 1; i <= 11; i++) vars[String(i)] = { type: 'static', value: `v${i}` }
    expect(resolveVariables(vars, contact())[9]).toBe('v10')
  })
})