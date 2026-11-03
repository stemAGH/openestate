import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';

/**
 * v0.8.4: plain messages for the three foreign keys restored as ON DELETE
 * RESTRICT (migration 20261022000000_restore_foreign_keys), and since v0.9
 * bookings.interest_rule_id (20261101000000_booking_interest_rule). Without
 * this a refused delete surfaces as a raw 500.
 *
 * Lives here, not in PaymentPlanService or the masters factory, so the
 * frozen financial services are unchanged: they still let the database
 * refuse, and this turns that refusal into a 409. Every other error,
 * including every other foreign key violation, goes to Nest's default
 * handling exactly as before.
 *
 * Matches on Prisma's P2003 code by shape rather than `instanceof`: the API
 * and @openestate/db can load separate copies of the Prisma runtime, and an
 * instanceof check across them silently never matches.
 */
export const RESTRICT_MESSAGES: Record<string, string> = {
  ledger_entries_installment_id_fkey: "This installment has interest charged and can't be removed.",
  interest_accruals_installment_id_fkey: "This installment has interest charged and can't be removed.",
  interest_accruals_interest_rule_id_fkey:
    "This interest rule has been used to charge interest and can't be deleted. Mark it inactive instead.",
  // v0.9: was SET NULL, which silently switched off interest on the booking.
  bookings_interest_rule_id_fkey:
    "This interest rule is attached to a booking and can't be deleted. Mark it inactive instead.",
};

/** The plain message for a refused delete on one of the three links, or undefined. */
export function restrictMessageFor(err: unknown): string | undefined {
  const e = err as { code?: unknown; meta?: unknown; message?: unknown } | null;
  if (!e || e.code !== 'P2003') return undefined;
  const haystack = `${JSON.stringify(e.meta ?? {})} ${String(e.message ?? '')}`;
  for (const [name, message] of Object.entries(RESTRICT_MESSAGES)) {
    if (haystack.includes(name)) return message;
  }
  return undefined;
}

@Catch()
export class ForeignKeyRefusalFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const message = host.getType() === 'http' ? restrictMessageFor(exception) : undefined;
    if (!message) return super.catch(exception, host);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.CONFLICT)
      .json({ statusCode: HttpStatus.CONFLICT, message, error: 'Conflict' });
  }
}
