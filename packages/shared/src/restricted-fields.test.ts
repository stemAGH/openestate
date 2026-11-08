import { describe, it, expect } from 'vitest';
import { RESTRICTED_FIELDS, stripRestrictedFields } from './restricted-fields';

describe('stripRestrictedFields', () => {
  it('drops the encrypted value and its key version, keeps the masked value', () => {
    const row = { id: 'b1', name: 'Broker', panCiphertext: 'v1:abc', panKeyVersion: 1, panMasked: 'ABXXXXX34F' };
    expect(stripRestrictedFields(row)).toEqual({ id: 'b1', name: 'Broker', panMasked: 'ABXXXXX34F' });
  });

  it('reaches any depth: nested rows, lists, audit before/after', () => {
    const v = {
      data: [{ applicant: { name: 'A', panCiphertext: 'x', panKeyVersion: 2 } }],
      before: { pan_ciphertext: 'y', pan_key_version: 1, city: 'Pune' },
      after: { panCiphertext: '[REDACTED]' },
    };
    expect(stripRestrictedFields(v)).toEqual({
      data: [{ applicant: { name: 'A' } }],
      before: { city: 'Pune' },
      after: {},
    });
  });

  it('leaves dates, bigints, nulls and strings alone and does not change the input', () => {
    const d = new Date('2026-11-08T00:00:00Z');
    const row = { createdAt: d, amountPaise: 12n, note: null, panCiphertext: 'x' };
    const out = stripRestrictedFields(row);
    expect(out).toEqual({ createdAt: d, amountPaise: 12n, note: null });
    expect(out.createdAt).toBe(d);
    expect(row.panCiphertext).toBe('x');
    expect(stripRestrictedFields('panCiphertext')).toBe('panCiphertext');
  });

  it('lists both spellings of both fields', () => {
    expect([...RESTRICTED_FIELDS].sort()).toEqual(['panCiphertext', 'panKeyVersion', 'pan_ciphertext', 'pan_key_version']);
  });
});
