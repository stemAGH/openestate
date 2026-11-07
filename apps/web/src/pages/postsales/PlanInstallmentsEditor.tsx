import { formatInr } from '@openestate/shared';

export interface InstallmentRow {
  label: string;
  dueDate: string;
  /** Paise as a decimal string; '' while not entered. */
  amountPaise: string;
}

/** The sum of the rows, or null while any amount is missing. */
export function scheduledPaise(rows: InstallmentRow[]): bigint | null {
  if (rows.length === 0 || rows.some((r) => r.amountPaise === '')) return null;
  return rows.reduce((s, r) => s + BigInt(r.amountPaise), 0n);
}

/** True when every row is filled in and the amounts add up to `totalPaise` exactly. */
export function planMatchesTotal(rows: InstallmentRow[], totalPaise: bigint | null): boolean {
  const sum = scheduledPaise(rows);
  return totalPaise !== null && sum !== null && sum === totalPaise && rows.every((r) => r.label && r.dueDate);
}

/**
 * Rows of a custom payment plan, checked against the GST-inclusive total the
 * server will require (the booking quote, or a booking's agreed price).
 */
export default function PlanInstallmentsEditor({
  rows,
  onChange,
  totalPaise,
  defaultDueDate,
}: {
  rows: InstallmentRow[];
  onChange: (rows: InstallmentRow[]) => void;
  totalPaise: bigint | null;
  defaultDueDate: string;
}) {
  const set = (i: number, patch: Partial<InstallmentRow>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const sum = scheduledPaise(rows) ?? rows.reduce((s, r) => s + (r.amountPaise ? BigInt(r.amountPaise) : 0n), 0n);
  const remaining = totalPaise === null ? null : totalPaise - sum;

  return (
    <div className="mt-3 space-y-2">
      {rows.map((inst, i) => (
        <div key={i} className="flex gap-2">
          <input
            type="text"
            placeholder="Label"
            aria-label={`Installment ${i + 1} label`}
            value={inst.label}
            onChange={(e) => set(i, { label: e.target.value })}
            className="w-1/3 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <input
            type="date"
            aria-label={`Installment ${i + 1} due date`}
            value={inst.dueDate}
            onChange={(e) => set(i, { dueDate: e.target.value })}
            className="w-1/3 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <input
            type="number"
            step="0.01"
            placeholder="Amount (₹)"
            aria-label={`Installment ${i + 1} amount`}
            value={inst.amountPaise ? Number(inst.amountPaise) / 100 : ''}
            onChange={(e) =>
              set(i, { amountPaise: e.target.value === '' ? '' : String(Math.round(Number(e.target.value) * 100)) })
            }
            className="w-1/3 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            aria-label={`Remove installment ${i + 1}`}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            className="text-xs text-red-600 hover:text-red-800"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { label: '', dueDate: defaultDueDate, amountPaise: '' }])}
        className="text-xs font-medium text-blue-600 hover:text-blue-800"
      >
        + Add installment
      </button>
      <div className="flex justify-between text-sm" data-testid="plan-total-check">
        <span className="text-slate-500">
          Scheduled {formatInr(sum)} of {totalPaise === null ? '…' : formatInr(totalPaise)} (GST included)
        </span>
        {remaining !== null && remaining !== 0n && (
          <span className="font-medium text-red-600">
            {remaining > 0n ? `${formatInr(remaining)} still to schedule` : `${formatInr(-remaining)} over the total`}
          </span>
        )}
        {remaining === 0n && <span className="font-medium text-emerald-700">Matches the total</span>}
      </div>
    </div>
  );
}
