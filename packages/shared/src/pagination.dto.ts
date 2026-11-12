import { z } from 'zod';

/** Postgres text can't hold or compare a NUL character: refuse it (400) instead of letting the query fail (500). */
export const hasNoNul = (s: string) => !s.includes(String.fromCharCode(0));
export const NO_NUL_MESSAGE = 'must not contain a NUL character';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(255).refine(hasNoNul, NO_NUL_MESSAGE).optional(),
  sortBy: z.string().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
