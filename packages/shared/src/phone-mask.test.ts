import { describe, it, expect } from 'vitest';
import { maskPhone, maskPhoneFields, maskPhonesInText, PHONE_MASK } from './phone-mask';

describe('maskPhone (last 4 digits)', () => {
  it.each([
    ['9876543210', '••••••3210'],
    ['+91 98765 43210', '••••••3210'],
    ['+919876543210', '••••••3210'],
    ['919876543210', '••••••3210'],
    ['09876543210', '••••••3210'],
    ['98765-43210', '••••••3210'],
    ['+44 7700 900123', '••••••0123'],
  ])('%s → %s', (raw, out) => {
    expect(maskPhone(raw)).toBe(out);
  });

  it('reveals nothing for 4 digits or fewer', () => {
    expect(maskPhone('1234')).toBe(PHONE_MASK);
    expect(maskPhone('12')).toBe(PHONE_MASK);
  });

  it('keeps empty and missing values as they are', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeUndefined();
  });
});

describe('maskPhoneFields', () => {
  it('masks every phone field of a row and leaves the rest', () => {
    const row = {
      id: 'a1', name: 'Priya', email: 'p@example.in',
      primaryPhone: '+91 98765 43210', primaryPhoneNormalized: '9876543210',
      alternatePhones: ['9123456789', '9000011111'], budgetMinPaise: '6000000000',
    };
    expect(maskPhoneFields(row)).toEqual({
      id: 'a1', name: 'Priya', email: 'p@example.in',
      primaryPhone: '••••••3210', primaryPhoneNormalized: '••••••3210',
      alternatePhones: ['••••••6789', '••••••1111'], budgetMinPaise: '6000000000',
    });
  });

  it('reaches nested rows, lists, and change-request from/to pairs', () => {
    const v = {
      data: [{ applicant: { name: 'A', primaryPhone: '9876543210' } }, { broker: { phone: '9988776655' } }],
      fieldChanges: { alternatePhones: { from: ['9123456789'], to: [] }, city: { from: 'Pune', to: 'Mumbai' } },
    };
    const out = maskPhoneFields(v);
    expect(out.data[0]?.applicant?.primaryPhone).toBe('••••••3210');
    expect(out.data[1]?.broker?.phone).toBe('••••••6655');
    expect(out.fieldChanges.alternatePhones).toEqual({ from: ['••••••6789'], to: [] });
    expect(out.fieldChanges.city).toEqual({ from: 'Pune', to: 'Mumbai' });
  });

  it('does not change the input', () => {
    const row = { primaryPhone: '9876543210' };
    maskPhoneFields(row);
    expect(row.primaryPhone).toBe('9876543210');
  });

  it('keeps nulls and dates', () => {
    const d = new Date('2026-11-08T00:00:00Z');
    expect(maskPhoneFields({ phone: null, createdAt: d })).toEqual({ phone: null, createdAt: d });
  });
});

describe('maskPhonesInText', () => {
  it('masks phone numbers in a URL query', () => {
    expect(maskPhonesInText('/api/v1/inquiries?search=9876543210&page=1')).toBe('/api/v1/inquiries?search=••••••3210&page=1');
    expect(maskPhonesInText('+91 98765 43210')).toBe('••••••3210');
  });

  it('leaves UUIDs, short numbers and words alone', () => {
    const url = '/api/v1/projects/550e8400-e29b-41d4-a716-446655440000/units?page=12&limit=100&year=2026';
    expect(maskPhonesInText(url)).toBe(url);
    expect(maskPhonesInText('abc1234567890')).toBe('abc1234567890');
  });
});
