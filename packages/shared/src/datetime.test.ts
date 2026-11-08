import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, istDayBounds, followUpDueLabel } from './datetime';

// IST midnight is 18:30 UTC the evening before. These tests use explicit UTC
// instants, so they hold whatever time zone the test process runs in.
describe('formatDate / formatDateTime (DD-MM-YYYY, IST)', () => {
  it('formats the IST calendar date, not the UTC one', () => {
    expect(formatDate('2026-11-08T18:29:59Z')).toBe('08-11-2026'); // 23:59 IST
    expect(formatDate('2026-11-08T18:30:00Z')).toBe('09-11-2026'); // 00:00 IST
  });

  it('handles year, month and leap-day edges', () => {
    expect(formatDate('2026-12-31T18:30:00Z')).toBe('01-01-2027');
    expect(formatDate('2028-02-28T18:30:00Z')).toBe('29-02-2028');
    expect(formatDate('2027-02-28T18:30:00Z')).toBe('01-03-2027');
    expect(formatDate('2026-03-31T18:30:00Z')).toBe('01-04-2026'); // financial-year start
  });

  it('accepts Date, ISO string and epoch ms alike', () => {
    const iso = '2026-01-05T04:00:00Z';
    expect(formatDate(new Date(iso))).toBe('05-01-2026');
    expect(formatDate(Date.parse(iso))).toBe('05-01-2026');
  });

  it('adds 24-hour IST time', () => {
    expect(formatDateTime('2026-11-08T08:35:00Z')).toBe('08-11-2026 14:05');
    expect(formatDateTime('2026-11-08T18:29:00Z')).toBe('08-11-2026 23:59');
    expect(formatDateTime('2026-11-08T18:30:00Z')).toBe('09-11-2026 00:00');
  });
});

describe('istDayBounds', () => {
  it('just before IST midnight (18:29 UTC) is still the earlier IST day', () => {
    const b = istDayBounds('2026-11-10T18:29:00Z');
    expect(b.startOfToday.toISOString()).toBe('2026-11-09T18:30:00.000Z');
    expect(b.endOfToday.toISOString()).toBe('2026-11-10T18:29:59.999Z');
  });

  it('just after IST midnight (18:31 UTC) is the next IST day', () => {
    const b = istDayBounds('2026-11-10T18:31:00Z');
    expect(b.startOfToday.toISOString()).toBe('2026-11-10T18:30:00.000Z');
    expect(b.endOfToday.toISOString()).toBe('2026-11-11T18:29:59.999Z');
  });

  it('exactly IST midnight starts the new day', () => {
    expect(istDayBounds('2026-11-10T18:30:00Z').startOfToday.toISOString()).toBe('2026-11-10T18:30:00.000Z');
  });
});

describe('followUpDueLabel (IST calendar days)', () => {
  const now = '2026-11-10T18:29:00Z'; // 23:59 IST on 10-11-2026

  it('same IST day is Today, even when the due time has passed', () => {
    expect(followUpDueLabel('2026-11-09T18:30:00Z', now)).toEqual({ label: 'Today', overdue: false });
    expect(followUpDueLabel('2026-11-10T18:29:59Z', now)).toEqual({ label: 'Today', overdue: false });
  });

  it('flips across IST midnight: a due time at 17:30 IST is Today at 23:59 and overdue at 00:01', () => {
    const due = '2026-11-10T12:00:00Z';
    expect(followUpDueLabel(due, '2026-11-10T18:29:00Z')).toEqual({ label: 'Today', overdue: false });
    expect(followUpDueLabel(due, '2026-11-10T18:31:00Z')).toEqual({ label: '1 day overdue', overdue: true });
  });

  it('counts days overdue and ahead', () => {
    expect(followUpDueLabel('2026-11-08T05:00:00Z', now)).toEqual({ label: '2 days overdue', overdue: true });
    expect(followUpDueLabel('2026-11-11T05:00:00Z', now)).toEqual({ label: 'Tomorrow', overdue: false });
    expect(followUpDueLabel('2026-11-14T05:00:00Z', now)).toEqual({ label: 'In 4 days', overdue: false });
  });
});
