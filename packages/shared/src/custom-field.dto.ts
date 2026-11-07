import { z } from 'zod';

export const CUSTOM_FIELD_TYPES = [
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
  'MULTI_SELECT',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_ENTITIES = [
  'INQUIRY',
  'BOOKING',
  'UNIT',
  'PROJECT',
  'APPLICANT',
] as const;

export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

/**
 * v0.2.3: the entity types that can actually STORE a value today —
 * i.e. the ones with a `custom_fields` JSONB column and server-side
 * validation wired into their create/update paths.
 *
 * BOOKING is in CUSTOM_FIELD_ENTITIES but not here yet: `bookings` has no
 * `custom_fields` column. It is planned for v0.8.0 PR 2
 * (internal plan uploaded-documents-plan.md §2f), which adds the column and
 * writes it from BookingController without editing BookingService. Until
 * then, rather than let an admin define a BOOKING field that silently does
 * nothing, definition creation for an unsupported entity is rejected at
 * the API boundary and the admin UI marks it unsupported.
 *
 * This list is the single source of truth for both halves of that check,
 * so the API and the UI can never drift apart on which types work.
 */
export const CUSTOM_FIELD_VALUE_ENTITIES = [
  'INQUIRY',
  'UNIT',
  'PROJECT',
  'APPLICANT',
] as const;

export type CustomFieldValueEntity = (typeof CUSTOM_FIELD_VALUE_ENTITIES)[number];

export function supportsCustomFieldValues(entityType: string): entityType is CustomFieldValueEntity {
  return (CUSTOM_FIELD_VALUE_ENTITIES as readonly string[]).includes(entityType);
}

/**
 * Hard purge is irreversible and strips a key from every row of an
 * entity, so a count alone isn't a meaningful confirmation — the admin
 * has no way to verify "340 rows" is right before agreeing to it.
 * Requiring the field's own key to be typed back makes the confirmation
 * about the THING being destroyed rather than about a number. Soft
 * delete (isActive=false) remains the default action and needs none of
 * this.
 */
export const purgeCustomFieldSchema = z
  .object({
    confirmKey: z.string().min(1).max(100),
  })
  .strict();

export type PurgeCustomFieldDto = z.infer<typeof purgeCustomFieldSchema>;

// ── Value validation ────────────────────────────────────────

/** The subset of a definition the value-validator actually needs. */
export interface CustomFieldDefinitionLike {
  key: string;
  fieldType: string;
  isRequired: boolean;
  options: unknown;
  /** Used in error messages; falls back to `key`. */
  label?: string;
  /** Layer (c): skip the Aadhaar value guard for this field. */
  allowsTwelveDigitValues?: boolean;
}

/**
 * DATE values are stored as canonical `YYYY-MM-DD` strings, not as
 * timestamps. A custom DATE field is a calendar date; storing it as an
 * instant would make it render as a different day depending on the
 * reader's timezone, which is a silent-wrong-data failure, not a
 * formatting nit. Input must be ISO-shaped so we never lean on
 * `new Date()`'s looser coercions (`new Date("5")` is a real date in
 * V8, and accepting that would be nonsense).
 */
const isoDateValue = z
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'Date must be ISO-8601 (YYYY-MM-DD)'), z.date()])
  .transform((v, ctx) => {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
      return z.NEVER;
    }
    return d.toISOString().slice(0, 10);
  });

function schemaForType(def: CustomFieldDefinitionLike): z.ZodTypeAny {
  const opts = Array.isArray(def.options) ? (def.options as string[]) : [];
  switch (def.fieldType as CustomFieldType) {
    case 'TEXT':
      // .min(1) so an empty string cannot satisfy a REQUIRED text field —
      // without it, a blank input silently passes a required check.
      return z.string().min(1).max(1000);
    case 'NUMBER':
      return z.number().finite();
    case 'DATE':
      return isoDateValue;
    case 'BOOLEAN':
      return z.boolean();
    case 'SELECT':
      // Defensive: z.enum([]) throws at CONSTRUCTION time, so a
      // definition whose options were emptied by a later update would
      // crash every save on that entity rather than reject one field.
      // The service also refuses to empty them; this is the second layer.
      return opts.length > 0 ? z.enum(opts as [string, ...string[]]) : z.never();
    case 'MULTI_SELECT':
      return opts.length > 0 ? z.array(z.enum(opts as [string, ...string[]])) : z.never();
    default:
      return z.never();
  }
}

/**
 * Builds a zod schema for one entity's custom field VALUES from its
 * active definitions — the Phase 1 design, finally wired up.
 *
 * `.strict()` is load-bearing: zod's default strips unknown keys
 * silently, which would let a client write arbitrary junk that simply
 * vanishes rather than being refused. Values have accepted arbitrary
 * unvalidated keys since Phase 3 (`z.record(z.unknown())`); rejecting
 * is the whole point of this release.
 *
 * Callers MUST pass only `isActive` definitions — a deactivated field
 * must stop being enforced without its stored values being touched.
 */
export function buildCustomFieldValueSchema(
  definitions: CustomFieldDefinitionLike[],
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const def of definitions) {
    const base = schemaForType(def);
    shape[def.key] = def.isRequired ? base : base.optional();
  }
  return z.object(shape).strict();
}

/**
 * Validates a full, already-merged value object. On PATCH the caller
 * must merge the incoming patch over the stored values BEFORE calling
 * this — validating the patch alone would let a partial update bypass
 * every required field simply by omitting it.
 */
export function validateCustomFieldValues(
  definitions: CustomFieldDefinitionLike[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  return buildCustomFieldValueSchema(definitions).parse(values) as Record<string, unknown>;
}

export const createCustomFieldSchema = z
  .object({
    entityType: z.enum(CUSTOM_FIELD_ENTITIES),
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/, 'Key must be lowercase snake_case'),
    label: z.string().min(1).max(255),
    fieldType: z.enum(CUSTOM_FIELD_TYPES),
    isRequired: z.boolean().default(false),
    options: z.array(z.string().max(255)).optional(),
    defaultValue: z.string().max(500).optional(),
    // v0.8.0 layer (c): skip the Aadhaar value guard for this field.
    allowsTwelveDigitValues: z.boolean().default(false),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateCustomFieldDto = z.infer<typeof createCustomFieldSchema>;

export const updateCustomFieldSchema = z
  .object({
    label: z.string().min(1).max(255).optional(),
    isRequired: z.boolean().optional(),
    options: z.array(z.string().max(255)).optional(),
    defaultValue: z.string().max(500).optional(),
    allowsTwelveDigitValues: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

export type UpdateCustomFieldDto = z.infer<typeof updateCustomFieldSchema>;
