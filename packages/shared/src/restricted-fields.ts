/**
 * Fields that never leave the server and are never written into an audit
 * snapshot: an identifier's encrypted value and its key version. Only the
 * masked value (e.g. `panMasked`) is shown. Both spellings: Prisma's
 * camelCase and the raw column names.
 */
export const RESTRICTED_FIELDS: ReadonlySet<string> = new Set([
  'panCiphertext',
  'panKeyVersion',
  'pan_ciphertext',
  'pan_key_version',
]);

/**
 * A copy of `value` without any restricted field, at any depth. Only plain
 * objects and arrays are walked; anything else (Date, BigInt, Decimal,
 * Buffer) is returned as is. The API applies this to every JSON response,
 * and the audit writer to every snapshot, so a new endpoint can't miss it.
 */
export function stripRestrictedFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripRestrictedFields(v)) as T;
  if (!value || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!RESTRICTED_FIELDS.has(k)) out[k] = stripRestrictedFields(v);
  }
  return out as T;
}
