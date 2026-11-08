import { useQuery } from '@tanstack/react-query';
import { supportsCustomFieldValues, maskAadhaarLike, PERMISSIONS } from '@openestate/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export interface CustomFieldDefinition {
  id: string;
  entityType: string;
  key: string;
  fieldType: string;
  label: string;
  isRequired: boolean;
  options: string[] | null;
  isActive: boolean;
  sortOrder: number;
  allowsTwelveDigitValues?: boolean;
}

export type CustomFieldValues = Record<string, unknown>;

/**
 * Active definitions for an entity type, or [] for an unsupported one, or
 * when the user can't read custom-field definitions (GET /custom-fields
 * needs admin.custom-field.read, which sales roles don't hold). Asking
 * anyway was a silent 403 on every Inquiries page load.
 */
export function useCustomFieldDefinitions(entityType: string) {
  const { hasPermission } = useAuth();
  const supported = supportsCustomFieldValues(entityType);
  const query = useQuery<CustomFieldDefinition[]>({
    queryKey: ['custom-fields', entityType],
    queryFn: () => api(`/custom-fields?entityType=${entityType}`),
    enabled: supported && hasPermission(PERMISSIONS.ADMIN_CUSTOM_FIELD_READ),
  });
  return {
    ...query,
    definitions: (query.data ?? []).filter((d) => d.isActive),
  };
}

/**
 * Builds the `customFields` payload to send. HTML inputs only ever
 * produce strings, but the API validates against real types (a NUMBER
 * field's schema is `z.number()`, not a coerced string), so conversion
 * has to happen here rather than being papered over server-side with a
 * lenient coercion that would also accept `""` as 0.
 *
 * Empty/absent optional values are omitted entirely rather than sent as
 * `""` or `null` — an omitted key is "not provided", which is exactly
 * what an untouched optional field means.
 */
export function buildCustomFieldPayload(
  definitions: CustomFieldDefinition[],
  raw: Record<string, unknown>,
): CustomFieldValues | undefined {
  const out: CustomFieldValues = {};
  for (const def of definitions) {
    const v = raw[def.key];
    if (v === undefined || v === null || v === '') continue;
    switch (def.fieldType) {
      case 'NUMBER': {
        const n = Number(v);
        if (Number.isNaN(n)) continue;
        out[def.key] = n;
        break;
      }
      case 'BOOLEAN':
        out[def.key] = v === true || v === 'true';
        break;
      case 'MULTI_SELECT':
        out[def.key] = Array.isArray(v) ? v : [v];
        break;
      default:
        out[def.key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Renders one value as display text (detail views, list columns, CSV). */
export function formatCustomFieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

interface Props {
  definitions: CustomFieldDefinition[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

/**
 * Form inputs for an entity's active custom fields, driven entirely by
 * the definitions — no per-entity hardcoding, so a newly-defined field
 * appears on the form with no code change (which is the entire point of
 * custom fields).
 */
export default function CustomFieldInputs({ definitions, values, onChange }: Props) {
  if (definitions.length === 0) return null;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Custom fields</h3>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {definitions.map((def) => {
          const v = values[def.key];
          const label = (
            <label className="block text-sm font-medium text-slate-700">
              {def.label}
              {def.isRequired && <span className="text-red-600"> *</span>}
            </label>
          );
          const cls = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

          if (def.fieldType === 'BOOLEAN') {
            return (
              <div key={def.id} className="flex items-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={v === true}
                    onChange={(e) => onChange(def.key, e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  />
                  <span className="text-sm text-slate-700">
                    {def.label}
                    {def.isRequired && <span className="text-red-600"> *</span>}
                  </span>
                </label>
              </div>
            );
          }

          if (def.fieldType === 'SELECT') {
            return (
              <div key={def.id}>
                {label}
                <select
                  value={(v as string) ?? ''}
                  onChange={(e) => onChange(def.key, e.target.value)}
                  className={cls}
                >
                  <option value="">Select…</option>
                  {(def.options ?? []).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
            );
          }

          if (def.fieldType === 'MULTI_SELECT') {
            const selected = Array.isArray(v) ? (v as string[]) : [];
            return (
              <div key={def.id}>
                {label}
                <div className="mt-1 space-y-1">
                  {(def.options ?? []).map((o) => (
                    <label key={o} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.includes(o)}
                        onChange={(e) =>
                          onChange(
                            def.key,
                            e.target.checked ? [...selected, o] : selected.filter((s) => s !== o),
                          )
                        }
                        className="h-4 w-4 rounded border-slate-300 text-blue-600"
                      />
                      <span className="text-sm text-slate-700">{o}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          }

          return (
            <div key={def.id}>
              {label}
              <input
                type={def.fieldType === 'NUMBER' ? 'number' : def.fieldType === 'DATE' ? 'date' : 'text'}
                value={(v as string) ?? ''}
                onChange={(e) => onChange(def.key, e.target.value)}
                className={cls}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Display text with any Aadhaar-like number masked to its last four digits.
 * A DISPLAY measure only: the raw value is still stored and still present
 * in the API response.
 */
function maskedText(value: unknown): string {
  const text = formatCustomFieldValue(value);
  return typeof value === 'string' || typeof value === 'number' ? maskAadhaarLike(text) : text;
}

/** Read-only display of stored values, used on detail screens. */
export function CustomFieldDisplay({
  definitions,
  values,
}: {
  definitions: CustomFieldDefinition[];
  values: Record<string, unknown> | null | undefined;
}) {
  const stored = values ?? {};
  const definedKeys = new Set(definitions.map((d) => d.key));
  // Values with no active definition — a deactivated field, or data
  // written before validation existed. Shown rather than hidden: they
  // are real stored data, and silently hiding them is how orphaned
  // values go unnoticed forever.
  const orphaned = Object.keys(stored).filter((k) => !definedKeys.has(k));

  if (definitions.length === 0 && orphaned.length === 0) return null;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <h3 className="text-sm font-medium text-slate-700">Custom fields</h3>
      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {definitions.map((def) => (
          <div key={def.id} className="flex justify-between gap-3">
            <dt className="text-slate-500">{def.label}</dt>
            <dd className="text-slate-800">
              {def.allowsTwelveDigitValues ? formatCustomFieldValue(stored[def.key]) : maskedText(stored[def.key])}
            </dd>
          </div>
        ))}
        {orphaned.map((k) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-slate-400" title="No active custom field is defined for this key">
              {k} <span className="text-xs">(inactive)</span>
            </dt>
            <dd className="text-slate-500">{maskedText(stored[k])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
