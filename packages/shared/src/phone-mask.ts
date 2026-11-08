// Phone masking for list views and logs (CLAUDE.md security rules: "mask
// PAN/phone in list views and logs"). Detail views and exports keep the full
// number; everything that shows many people at once shows the last 4 digits.

export const PHONE_MASK = '••••••';

/** "+91 98765 43210" → "••••••3210". Nothing is revealed for a number of 4 digits or fewer. */
export function maskPhone(raw: string): string;
export function maskPhone(raw: string | null): string | null;
export function maskPhone(raw: string | null | undefined): string | null | undefined;
export function maskPhone(raw: string | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return raw;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 4 ? PHONE_MASK + digits.slice(-4) : PHONE_MASK;
}

/** Field names that hold a phone number anywhere in the data model. */
const PHONE_KEYS = new Set(['phone', 'primaryPhone', 'primaryPhoneNormalized', 'alternatePhones']);

function maskValue(v: unknown): unknown {
  if (typeof v === 'string') return maskPhone(v);
  if (Array.isArray(v)) return v.map(maskValue);
  // e.g. a change request's { alternatePhones: { from: [...], to: [...] } }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x)]));
  }
  return v;
}

/**
 * A copy of `value` with every phone field masked, at any depth: an
 * applicant, broker or user row, a list of them, or an audit row's
 * before/after snapshot. Other fields are returned unchanged.
 */
export function maskPhoneFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((x) => maskPhoneFields(x)) as T;
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, PHONE_KEYS.has(k) ? maskValue(v) : maskPhoneFields(v)]),
  ) as T;
}

/**
 * Masks phone-like digit runs (7+ digits, optionally with +, spaces or
 * hyphens) in free text such as a logged URL or query value. A digit run
 * that is part of a word or a UUID segment is left alone.
 */
export function maskPhonesInText(text: string): string {
  return text.replace(/(?<![\w-])\+?\d[\d\s-]*\d(?![\w-])/g, (m) =>
    m.replace(/\D/g, '').length >= 7 ? maskPhone(m) : m,
  );
}
