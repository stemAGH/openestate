import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInr, PERMISSIONS } from '@openestate/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

interface InterestRuleRow {
  id: string;
  name: string;
  rateType: string;
  ratePercent: string;
  isActive: boolean;
}

interface Props {
  bookingId: string;
  status: string;
  interestRuleId: string | null;
  interestFromDate: string | null;
  /** Set when the booking wizard created the booking but couldn't attach its rule. */
  wizardError?: string;
}

// Mirrors ACCRUING_STATUSES in apps/api/src/postsales/interest.service.ts.
const ACTIVE_STATUSES = new Set(['BOOKED', 'ALLOTTED', 'REGISTERED']);
const NO_INTEREST = 'NONE';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'UTC' });

/**
 * The booking's delay-interest rule (v0.9): shows it, lets a holder of
 * postsales.interest.manage attach, change or remove it, and lets manage or
 * waive holders accrue interest up to today.
 */
export default function InterestRulePanel({ bookingId, status, interestRuleId, interestFromDate, wizardError }: Props) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission(PERMISSIONS.POSTSALES_INTEREST_MANAGE);
  const canAccrue = canManage || hasPermission(PERMISSIONS.POSTSALES_INTEREST_WAIVE);
  const active = ACTIVE_STATUSES.has(status);

  const { data: rules } = useQuery<{ data: InterestRuleRow[] }>({
    queryKey: ['interest-rules-all'],
    queryFn: () => api('/masters/interest-rules?limit=100'),
    enabled: hasPermission(PERMISSIONS.ADMIN_MASTER_READ),
  });
  const current = rules?.data.find((r) => r.id === interestRuleId);
  // Only active SIMPLE rules can be attached for now (compounding waits for the CA).
  const attachable = (rules?.data ?? []).filter((r) => r.isActive && r.rateType === 'SIMPLE');

  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function applyChoice() {
    setBusy(true);
    setMessage('');
    try {
      const res = await api<{ settledPaise: string }>(`/bookings/${bookingId}/interest-rule`, {
        method: 'PUT',
        body: JSON.stringify({ interestRuleId: choice === NO_INTEREST ? null : choice }),
      });
      const settled = BigInt(res.settledPaise);
      setMessage(
        (choice === NO_INTEREST ? 'Delay interest removed.' : 'Interest rule set; it applies from today.') +
          (settled > 0n ? ` Interest up to today under the previous rule: ${formatInr(settled)}.` : ''),
      );
      setChoice('');
      qc.invalidateQueries({ queryKey: ['booking', bookingId] });
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function accrue() {
    setBusy(true);
    setMessage('');
    try {
      const res = await api<{ postedPaise: string }>(`/bookings/${bookingId}/interest/accrue`, { method: 'POST' });
      const posted = BigInt(res.postedPaise);
      setMessage(posted > 0n ? `Interest charged: ${formatInr(posted)}.` : 'No interest is due as of today.');
      qc.invalidateQueries({ queryKey: ['booking', bookingId] });
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Delay interest" className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Delay interest</h2>
      {wizardError && (
        <p role="alert" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The booking was created, but its interest rule wasn't attached: {wizardError}
        </p>
      )}
      <p className="mt-1 text-sm text-slate-700" data-testid="interest-rule-current">
        {interestRuleId
          ? `${current ? `${current.name} (${Number(current.ratePercent)}% simple)` : 'A rule is attached'}` +
            (interestFromDate ? `, from ${fmtDate(interestFromDate)}` : '')
          : 'No delay interest.'}
      </p>

      {canManage && active && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label htmlFor="interest-rule-choice" className="sr-only">Interest rule</label>
          <select
            id="interest-rule-choice"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value="" disabled>{interestRuleId ? 'Change to…' : 'Attach…'}</option>
            {interestRuleId && <option value={NO_INTEREST}>No delay interest (remove)</option>}
            {attachable
              .filter((r) => r.id !== interestRuleId)
              .map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({Number(r.ratePercent)}% simple)</option>
              ))}
          </select>
          <button
            onClick={applyChoice}
            disabled={busy || !choice}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Apply
          </button>
          <span className="text-xs text-slate-500">
            Takes effect from today. Interest already charged stays as charged.
          </span>
        </div>
      )}

      {canAccrue && active && interestRuleId && (
        <div className="mt-3">
          <button
            onClick={accrue}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Accrue interest now'}
          </button>
        </div>
      )}

      {message && <p className="mt-2 text-sm text-slate-600" data-testid="interest-message">{message}</p>}
    </section>
  );
}
