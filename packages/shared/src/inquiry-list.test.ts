import { describe, it, expect } from 'vitest';
import { whatsAppNumber, inquiryListQuerySchema, INQUIRY_STATUS_LABELS } from './presales';

describe('whatsAppNumber', () => {
  it.each([
    ['9876543210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['+919876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['91-98765-43210', '919876543210'],
    ['09876543210', '919876543210'],
    ['  98765-43210 ', '919876543210'],
  ])('Indian mobile %s gets a single 91: %s', (raw, out) => {
    expect(whatsAppNumber(raw)).toBe(out);
  });

  it('keeps a foreign number stored with its own + prefix', () => {
    expect(whatsAppNumber('+44 7700 900123')).toBe('447700900123');
  });

  it('returns null when the country cannot be known', () => {
    expect(whatsAppNumber('020 2567 8901')).toBeNull(); // landline-ish, no +
    expect(whatsAppNumber('12345')).toBeNull();
    expect(whatsAppNumber('')).toBeNull();
  });
});

describe('inquiryListQuerySchema', () => {
  const parse = (q: Record<string, string>) => inquiryListQuerySchema.safeParse(q);

  it('defaults page and limit', () => {
    expect(parse({}).data).toMatchObject({ page: 1, limit: 20, sortOrder: 'asc' });
  });

  it('splits a comma-separated status list', () => {
    expect(parse({ status: 'OPEN,CONTINUED' }).data?.status).toEqual(['OPEN', 'CONTINUED']);
  });

  it.each([
    [{ status: 'OPEN,LOST' }],
    [{ status: ',' }],
    [{ followUp: 'tomorrow' }],
    [{ sortBy: 'passwordHash' }],
    [{ sortBy: 'status' }],
    [{ projectId: 'not-a-uuid' }],
    [{ search: 'a' }],
    [{ stageId: '00000000-0000-0000-0000-000000000000' }],
  ])('rejects %o', (q) => {
    expect(parse(q).success).toBe(false);
  });

  it('accepts the sortable columns', () => {
    expect(parse({ sortBy: 'nextFollowupAt', sortOrder: 'desc' }).success).toBe(true);
    expect(parse({ sortBy: 'createdAt' }).success).toBe(true);
  });

  it('has a label for every status', () => {
    expect(Object.values(INQUIRY_STATUS_LABELS)).toEqual(['Open', 'Continued', 'Dumped', 'Successful']);
  });
});
