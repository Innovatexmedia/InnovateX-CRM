import { describe, expect, it } from 'vitest';

import { istToDate } from './schedule';
import {
  firstNameOf,
  resolveEventVariables,
  validateEventVariables,
  type EventContext,
  type EventVariableMapping,
} from './variables';

const ev: EventContext = {
  name: 'Free Wealth Webinar',
  eventAt: istToDate('2026-11-01', '19:00')!,
  joinLink: 'https://zoom.us/j/123',
  location: null,
};

describe('firstNameOf', () => {
  it('takes the first word', () => {
    expect(firstNameOf('Rahul Sharma')).toBe('Rahul');
    expect(firstNameOf('  Priya  ')).toBe('Priya');
  });
  it('treats empty and symbol-only names as empty', () => {
    expect(firstNameOf('')).toBe('');
    expect(firstNameOf(null)).toBe('');
    expect(firstNameOf('.')).toBe('');
    expect(firstNameOf('🙂')).toBe('');
  });
  it('keeps non-latin names', () => {
    expect(firstNameOf('राहुल कुमार')).toBe('राहुल');
  });
});

describe('resolveEventVariables', () => {
  const vars: Record<string, EventVariableMapping> = {
    '1': { type: 'field', value: 'first_name', fallback: 'there' },
    '2': { type: 'event', value: 'event_name' },
    '3': { type: 'event', value: 'event_datetime' },
  };

  it('fills contact, event name and date/time in placeholder order', () => {
    expect(resolveEventVariables(vars, { name: 'Rahul Sharma' }, undefined, ev)).toEqual([
      'Rahul',
      'Free Wealth Webinar',
      '1 Nov 2026, 7:00 PM',
    ]);
  });

  it('uses the fallback when the contact has no usable name', () => {
    expect(resolveEventVariables(vars, { name: null }, undefined, ev)[0]).toBe('there');
    expect(resolveEventVariables(vars, { name: '.' }, undefined, ev)[0]).toBe('there');
  });

  it('leaves it empty (so that recipient fails clearly) with no fallback', () => {
    const v = { '1': { type: 'field', value: 'name' } } as Record<string, EventVariableMapping>;
    expect(resolveEventVariables(v, { name: '' }, undefined, ev)).toEqual(['']);
  });

  it('sorts placeholders numerically, so {{2}} comes before {{10}}', () => {
    const v: Record<string, EventVariableMapping> = {
      '10': { type: 'static', value: 'ten' },
      '2': { type: 'static', value: 'two' },
      '1': { type: 'static', value: 'one' },
    };
    expect(resolveEventVariables(v, {}, undefined, ev)).toEqual(['one', 'two', 'ten']);
  });

  it('reads join link, date, time and location from the event', () => {
    const v: Record<string, EventVariableMapping> = {
      '1': { type: 'event', value: 'join_link' },
      '2': { type: 'event', value: 'event_date' },
      '3': { type: 'event', value: 'event_time' },
      '4': { type: 'event', value: 'location', fallback: 'Online' },
    };
    expect(resolveEventVariables(v, {}, undefined, ev)).toEqual([
      'https://zoom.us/j/123',
      '1 Nov 2026',
      '7:00 PM',
      'Online',
    ]);
  });

  it('reads custom fields by id', () => {
    const v: Record<string, EventVariableMapping> = {
      '1': { type: 'custom_field', value: 'cf-1', fallback: 'n/a' },
      '2': { type: 'custom_field', value: 'cf-2', fallback: 'n/a' },
    };
    const values = new Map([['cf-1', ' Delhi ']]);
    expect(resolveEventVariables(v, {}, values, ev)).toEqual(['Delhi', 'n/a']);
  });
});

describe('validateEventVariables', () => {
  it('flags a join-link variable when the event has no link', () => {
    const v: Record<string, EventVariableMapping> = {
      '2': { type: 'event', value: 'join_link' },
    };
    const problems = validateEventVariables(v, { ...ev, joinLink: '' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/\{\{2\}\}.*no a join link|join link/);
  });

  it('is happy with a fallback or a present value', () => {
    const v: Record<string, EventVariableMapping> = {
      '2': { type: 'event', value: 'location', fallback: 'Online' },
      '3': { type: 'event', value: 'join_link' },
    };
    expect(validateEventVariables(v, ev)).toEqual([]);
  });

  it('flags a blank static value', () => {
    const v: Record<string, EventVariableMapping> = { '1': { type: 'static', value: '  ' } };
    expect(validateEventVariables(v, ev)).toHaveLength(1);
  });
});