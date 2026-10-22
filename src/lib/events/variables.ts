/**
 * Event Campaign variable resolution — pure functions, no I/O.
 *
 * Same idea as the broadcast wizard's variable mapping (static value /
 * contact field / custom field, each with an optional fallback), plus a
 * fourth source, `event`, that reads the campaign's own event details.
 */

import {
  formatEventDate,
  formatEventDateTime,
  formatEventTime,
} from './schedule';

export type EventVariableType = 'static' | 'field' | 'custom_field' | 'event';

export interface EventVariableMapping {
  type: EventVariableType;
  /** static: the text. field: a CONTACT_FIELDS value. custom_field: custom_fields.id.
   *  event: an EVENT_FIELDS value. */
  value: string;
  fallback?: string;
}

export const CONTACT_FIELDS = ['name', 'first_name', 'phone', 'email', 'company'] as const;
export const EVENT_FIELDS = [
  'event_name',
  'event_date',
  'event_time',
  'event_datetime',
  'join_link',
  'location',
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];
export type EventField = (typeof EVENT_FIELDS)[number];

export interface EventContext {
  name: string;
  eventAt: Date;
  joinLink?: string | null;
  location?: string | null;
}

export interface ContactLike {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * First word of a full name. A name with no letters or digits at all
 * (".", "-", "🙂") counts as empty, so the fallback is used rather than
 * greeting someone with a symbol.
 */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) return '';
  return trimmed.split(/\s+/)[0];
}

function contactValue(field: string, c: ContactLike): string {
  switch (field) {
    case 'name': {
      const n = (c.name ?? '').trim();
      return n && /[\p{L}\p{N}]/u.test(n) ? n : '';
    }
    case 'first_name':
      return firstNameOf(c.name);
    case 'phone':
      return c.phone ?? '';
    case 'email':
      return c.email ?? '';
    case 'company':
      return c.company ?? '';
    default:
      return '';
  }
}

export function eventValue(field: string, ev: EventContext): string {
  switch (field) {
    case 'event_name':
      return ev.name;
    case 'event_date':
      return formatEventDate(ev.eventAt);
    case 'event_time':
      return formatEventTime(ev.eventAt);
    case 'event_datetime':
      return formatEventDateTime(ev.eventAt);
    case 'join_link':
      return (ev.joinLink ?? '').trim();
    case 'location':
      return (ev.location ?? '').trim();
    default:
      return '';
  }
}

function sortedKeys(vars: Record<string, EventVariableMapping>): string[] {
  return Object.keys(vars).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });
}

/**
 * Resolve every template placeholder for one contact, in {{1}}, {{2}}, …
 * order. Meta rejects an empty parameter, so an empty value falls back to
 * the mapping's `fallback` when set; otherwise it stays empty and the send
 * layer fails that one recipient with a clear "no value" error.
 */
export function resolveEventVariables(
  vars: Record<string, EventVariableMapping>,
  contact: ContactLike,
  customValues: Map<string, string> | undefined,
  ev: EventContext,
): string[] {
  return sortedKeys(vars).map((key) => {
    const m = vars[key];
    let raw = '';
    if (m.type === 'static') return m.value;
    if (m.type === 'field') raw = contactValue(m.value, contact);
    else if (m.type === 'custom_field') raw = (customValues?.get(m.value) ?? '').trim();
    else if (m.type === 'event') raw = eventValue(m.value, ev);
    return raw.trim() ? raw : (m.fallback ?? '').trim();
  });
}

/**
 * Problems that would make every recipient fail, detectable up front:
 * an Event-sourced variable (join link / location) pointing at a value
 * the event doesn't have, or a static value left blank.
 */
export function validateEventVariables(
  vars: Record<string, EventVariableMapping>,
  ev: EventContext,
): string[] {
  const problems: string[] = [];
  for (const key of sortedKeys(vars)) {
    const m = vars[key];
    if (m.type === 'event' && !eventValue(m.value, ev) && !(m.fallback ?? '').trim()) {
      const what = m.value === 'join_link' ? 'a join link' : m.value === 'location' ? 'a location' : 'a value';
      problems.push(`{{${key}}} uses the event's ${m.value.replace('_', ' ')}, but the event has no ${what}.`);
    }
    if (m.type === 'static' && !m.value.trim()) {
      problems.push(`{{${key}}} is a static value but it is empty.`);
    }
  }
  return problems;
}

/** Is this value one the mapping UI/API accepts for the given type? */
export function isKnownMapping(m: EventVariableMapping): boolean {
  if (m.type === 'field') return (CONTACT_FIELDS as readonly string[]).includes(m.value);
  if (m.type === 'event') return (EVENT_FIELDS as readonly string[]).includes(m.value);
  if (m.type === 'static' || m.type === 'custom_field') return typeof m.value === 'string';
  return false;
}