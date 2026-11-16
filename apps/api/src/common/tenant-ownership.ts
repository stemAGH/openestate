import { NotFoundException } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks that every id a request names belongs to the caller's company,
 * before the write that stores it. Row-level security filters reads, but a
 * foreign key is checked by Postgres without RLS: an id of another
 * company's row would otherwise be stored as given.
 *
 * Each entry is [Prisma model delegate name, id or ids (absent = skip),
 * label for the 404 message]. Same rule as
 * LeadStageTransitionService.assertStageBelongsToCompany, for every field.
 */
export async function assertOwnedByCompany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Prisma client or transaction client
  tx: any,
  companyId: string,
  refs: Array<[model: string, id: string | readonly string[] | null | undefined, label: string]>,
): Promise<void> {
  for (const [model, id, label] of refs) {
    const ids = id == null ? [] : typeof id === 'string' ? [id] : [...new Set(id)];
    if (ids.length === 0) continue;
    // A value that isn't a UUID can't name a row (and would make the query fail).
    if (!ids.every((x) => UUID.test(x))) throw new NotFoundException(`${label} not found`);
    const found = await tx[model].count({ where: { id: { in: ids }, companyId } });
    if (found !== ids.length) throw new NotFoundException(`${label} not found`);
  }
}
