// Dates are shown DD-MM-YYYY in India Standard Time (CLAUDE.md India-first
// rules), whatever time zone the browser or the server process runs in.
//
// ponytail: IST is a fixed UTC+05:30 with no daylight saving, so a constant
// offset is exact. Move to the company's configured time zone (Intl) when a
// non-IST company needs it.
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

type DateInput = Date | string | number;

const toMs = (d: DateInput) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
const pad = (n: number) => String(n).padStart(2, '0');

/** The same instant, shifted so its UTC fields read as IST wall-clock time. */
const ist = (d: DateInput) => new Date(toMs(d) + IST_OFFSET_MS);

/** "08-11-2026" (IST calendar date). */
export function formatDate(d: DateInput): string {
  const x = ist(d);
  return `${pad(x.getUTCDate())}-${pad(x.getUTCMonth() + 1)}-${x.getUTCFullYear()}`;
}

/** "08-11-2026 14:05" (IST, 24-hour). */
export function formatDateTime(d: DateInput): string {
  const x = ist(d);
  return `${formatDate(d)} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
}

/** Whole IST calendar days since the epoch. */
function istDayNumber(d: DateInput): number {
  return Math.floor((toMs(d) + IST_OFFSET_MS) / DAY_MS);
}

/**
 * Start and end of `now`'s IST calendar day, as real instants. "Due today"
 * is [startOfToday, endOfToday]; "overdue" is before startOfToday. The
 * dashboard tiles, the inquiry list filter and the list's labels all use
 * this, so they always agree.
 */
export function istDayBounds(now: DateInput): { startOfToday: Date; endOfToday: Date } {
  const start = istDayNumber(now) * DAY_MS - IST_OFFSET_MS;
  return { startOfToday: new Date(start), endOfToday: new Date(start + DAY_MS - 1) };
}

/** "Today", "Tomorrow", "In 3 days", "1 day overdue", "4 days overdue". */
export function followUpDueLabel(due: DateInput, now: DateInput): { label: string; overdue: boolean } {
  const diff = istDayNumber(due) - istDayNumber(now);
  if (diff === 0) return { label: 'Today', overdue: false };
  if (diff === 1) return { label: 'Tomorrow', overdue: false };
  if (diff > 1) return { label: `In ${diff} days`, overdue: false };
  return { label: `${-diff} day${diff === -1 ? '' : 's'} overdue`, overdue: true };
}
