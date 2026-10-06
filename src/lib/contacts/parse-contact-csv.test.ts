import { describe, expect, it } from 'vitest';
import {
  normalizeImportPhone,
  parseContactCsv,
  parseTagCell,
} from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: true,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('keeps a row with an empty phone cell instead of dropping it silently', () => {
    const csv = `phone,name
+15551234567,Alice
,Bob`;

    const { rows } = parseContactCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      phone: '',
      name: 'Bob',
      email: undefined,
      company: undefined,
      tagNames: [],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });
});

describe('normalizeImportPhone', () => {
  it('adds + to a 12-digit Indian number that starts with 91', () => {
    expect(normalizeImportPhone('918744853585')).toBe('+918744853585');
  });

  it('adds +91 to a 10-digit Indian mobile number', () => {
    expect(normalizeImportPhone('8744853585')).toBe('+918744853585');
  });

  it('tolerates spaces, dashes and brackets in digit-only numbers', () => {
    expect(normalizeImportPhone('91 87448-53585')).toBe('+918744853585');
    expect(normalizeImportPhone('(87448) 53585')).toBe('+918744853585');
  });

  it('leaves numbers that already have + unchanged (any country)', () => {
    expect(normalizeImportPhone('+918744853585')).toBe('+918744853585');
    expect(normalizeImportPhone('+14155550123')).toBe('+14155550123');
  });

  it('does not guess for other lengths or non-mobile prefixes', () => {
    expect(normalizeImportPhone('9109366426535')).toBe('9109366426535');
    expect(normalizeImportPhone('4155550123')).toBe('4155550123');
    expect(normalizeImportPhone('911234567890')).toBe('911234567890');
    expect(normalizeImportPhone('12345')).toBe('12345');
  });

  it('leaves blanks and text alone', () => {
    expect(normalizeImportPhone('')).toBe('');
    expect(normalizeImportPhone('  ')).toBe('');
    expect(normalizeImportPhone('abc123')).toBe('abc123');
  });
});

describe('parseContactCsv Indian phone normalization', () => {
  it('turns bare Indian numbers into + numbers so import accepts them', () => {
    const csv = `phone,name
918744853585,Gayatri
9975459997,Shrikant
+14155550123,Alex
9109366426535,Bad`;

    const { rows } = parseContactCsv(csv);
    expect(rows.map((r) => r.phone)).toEqual([
      '+918744853585',
      '+919975459997',
      '+14155550123',
      '9109366426535',
    ]);
  });
});