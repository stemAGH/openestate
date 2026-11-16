import { Prisma } from '@prisma/client';

/**
 * Deleted leads (v0.10.1): an inquiry with `deletedAt` set is hidden from
 * every read, on both clients, until it is restored or purged. One place,
 * rather than a filter in each of the forty-odd queries that read inquiries
 * (lists, search, detail, dashboard, reports, reminders, escalation).
 *
 * - Inquiry reads, update and updateMany get `deletedAt: null` added to
 *   their where, unless the where names `deletedAt` itself (the delete,
 *   restore, deleted-list and purge code paths do, explicitly).
 * - Reads of the rows that belong to a lead (follow-ups, assignments, stage
 *   and disposition history) get `inquiry: { deletedAt: null }`, unless the
 *   where already filters the inquiry's `deletedAt`.
 *
 * Communication logs are not filtered: they are the applicant's send history.
 */
const INQUIRY_OPS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany',
]);
const CHILD_READ_OPS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy',
]);
const CHILD_MODELS = new Set(['FollowUp', 'InquiryAssignment', 'InquiryStageHistory', 'InquiryDispositionHistory']);

type Where = Record<string, unknown>;

function namesDeletedAt(where: unknown): boolean {
  return !!where && typeof where === 'object' && Object.prototype.hasOwnProperty.call(where, 'deletedAt');
}

export function softDeleteExtension() {
  return Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const a = (args ?? {}) as any;
            if (model === 'Inquiry' && INQUIRY_OPS.has(operation)) {
              if (!namesDeletedAt(a.where)) a.where = { ...(a.where ?? {}), deletedAt: null };
              return query(a);
            }
            if (model && CHILD_MODELS.has(model) && CHILD_READ_OPS.has(operation)) {
              const where: Where = a.where ?? {};
              if (!namesDeletedAt(where.inquiry)) {
                if (where.inquiry === undefined) {
                  a.where = { ...where, inquiry: { deletedAt: null } };
                } else {
                  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
                  a.where = { ...where, AND: [...and, { inquiry: { deletedAt: null } }] };
                }
              }
              return query(a);
            }
            return query(args);
          },
        },
      },
    }),
  );
}
