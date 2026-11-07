/**
 * Aadhaar guard for custom fields (v0.8.0) — deterrence against
 * ACCIDENTAL storage, not prevention. See
 * internal plan uploaded-documents-plan.md §2h.
 *
 * - Layer (a), `containsAadhaarKeyword`: refuses custom-field keys and
 *   labels that name Aadhaar. Known false positive: आधार is also the
 *   Hindi word for "base" (आधार मूल्य, "base price").
 * - Layer (b), `findAadhaarLikeNumbers`: 12 digits, first digit 2–9,
 *   optionally grouped 4-4-4 by spaces or hyphens, with a valid Verhoeff
 *   checksum. About 1 in 10 random 12-digit numbers pass the checksum by
 *   chance (proven by this module's own test), and an Aadhaar number with
 *   one mistyped digit never does. Other separators (dots) aren't matched.
 * - Layer (c), the per-field exemption, lives on the definition.
 *
 * Verhoeff tables: Wikipedia "Verhoeff algorithm", citing Verhoeff (1969).
 * UIDAI's numbering document names Verhoeff but does not pin the
 * permutation, so v0.8.0 is not tagged until a human has checked this
 * against real numbers (the internal release plan).
 */

// d[a][b]: the dihedral group D5 — element i < 5 is the rotation
// x → x + i on Z5, i ≥ 5 the reflection x → (i − 5) − x, and d[a][b] is
// a ∘ b. The unit test derives this table from that definition.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// P[i] is the permutation (0 1 5 8 9 4 2 7)(3 6) applied i times.
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Exported for the table-derivation test only. */
export const VERHOEFF_TABLES = { D, P, INV } as const;

/** Check digit to append to `digits` (a string of 0–9). */
export function verhoeffCheckDigit(digits: string): number {
  let c = 0;
  const n = digits.length;
  for (let i = 0; i < n; i++) {
    c = D[c][P[(i + 1) % 8][Number(digits[n - 1 - i])]];
  }
  return INV[c];
}

/** True when `digits` (check digit last) has a valid Verhoeff checksum. */
export function isValidVerhoeff(digits: string): boolean {
  let c = 0;
  const n = digits.length;
  for (let i = 0; i < n; i++) {
    c = D[c][P[i % 8][Number(digits[n - 1 - i])]];
  }
  return c === 0;
}

// Zero-width lookahead so overlapping windows are all tried — a 16-digit
// number in 4-4-4-4 groups has two 12-digit windows.
const CANDIDATE = /(?<!\d)(?=([2-9]\d{3}[ -]?\d{4}[ -]?\d{4})(?!\d))/g;

export interface AadhaarLikeMatch {
  start: number;
  end: number;
  digits: string;
}

/** Every Aadhaar-like number in `text`: pattern AND valid checksum. */
export function findAadhaarLikeNumbers(text: string): AadhaarLikeMatch[] {
  const out: AadhaarLikeMatch[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const digits = m[1].replace(/[ -]/g, '');
    if (isValidVerhoeff(digits)) out.push({ start: m.index!, end: m.index! + m[1].length, digits });
  }
  return out;
}

/** Layer (b) on one custom-field value. Only strings and numbers can hold one. */
export function isAadhaarLikeValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && findAadhaarLikeNumbers(String(value)).length > 0;
  if (typeof value === 'string') return findAadhaarLikeNumbers(value).length > 0;
  return false;
}

function replaceMatches(text: string, replace: (m: AadhaarLikeMatch) => string): string {
  const matches = findAadhaarLikeNumbers(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlapping window already replaced
    out += text.slice(cursor, m.start) + replace(m);
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

export const AADHAAR_REDACTION = '[Aadhaar-like number removed]';

/** For machine-written text (lead notes, import notes): no digits kept. */
export function redactAadhaarLike(text: string): string {
  return replaceMatches(text, () => AADHAAR_REDACTION);
}

/** For display and export: UIDAI-style, last four digits kept. */
export function maskAadhaarLike(text: string): string {
  return replaceMatches(text, (m) => `XXXX XXXX ${m.digits.slice(8)}`);
}

// ── Layer (a) ──────────────────────────────────────────────

const SUBSTRING_WORDS = ['aadhaar', 'aadhar', '\u0906\u0927\u093E\u0930'] as const;
// Whole-word only: as substrings of the stripped string these matched
// "Via Dharavi", "Road hardware", "Radharani Nagar" and more.
const WHOLE_WORD_WORDS = ['adhaar', 'adhar'] as const;

const NOT_WORD_CHAR = /[^a-z0-9\p{Script=Devanagari}]+/gu;

function foldDevanagari(s: string): string {
  // NFKC leaves आधार alone (आ has no decomposition), so the two spellings
  // it doesn't unify are folded by hand: अ + ा typed for आ, and a nukta.
  return s.replace(/\u0905\u093E/g, '\u0906').replace(/\u093C/g, '');
}

/** The blocked word `text` contains, or null. Applied to a key or a label. */
export function containsAadhaarKeyword(text: string): string | null {
  const lowered = text.normalize('NFKC').toLowerCase();
  const stripped = foldDevanagari(lowered.replace(NOT_WORD_CHAR, ''));
  for (const w of SUBSTRING_WORDS) if (stripped.includes(w)) return w;
  const tokens = lowered.split(NOT_WORD_CHAR);
  for (const w of WHOLE_WORD_WORDS) if (tokens.includes(w)) return w;
  return null;
}

export function aadhaarKeywordError(matched: string): string {
  const reword =
    matched === '\u0906\u0927\u093E\u0930'
      ? 'If you meant "base" rather than the Aadhaar card, use a different word, such as \u092E\u0942\u0932.'
      : 'Reword the field name or label.';
  return `Custom field names and labels can't refer to Aadhaar (matched "${matched}"). ${reword}`;
}

export function aadhaarValueError(label: string): string {
  return (
    `${label}: this looks like an Aadhaar number. Don't store Aadhaar numbers in custom fields. ` +
    `If this is a different 12-digit number, such as a bank account number, an admin can allow ` +
    `12-digit values on this field.`
  );
}
