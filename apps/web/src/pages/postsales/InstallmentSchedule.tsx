import { useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInr } from '@openestate/shared';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';
import InterestRulePanel from './InterestRulePanel';

interface Installment {
  id: string;
  seq: number;
  label: string;
  /** Null for an unraised STAGE_LINKED installment — see
   * docs/plans/construction-linked-demand-fix.md §2. */
  dueDate: string | null;
  amountPaise: string;
  allocatedPaise: string;
  status: string;
}

interface PlanVersion {
  id: string;
  name: string;
  version: number;
  isActive: boolean;
  isCustom: boolean;
  createdAt: string;
  installments: Installment[];
}

interface BookingRow {
  brokerId: string | null;
  status: string;
  interestRuleId: string | null;
  interestFromDate: string | null;
}

// Mirrors CANCELLABLE_FROM in apps/api/src/postsales/cancellation.service.ts.
const CANCELABLE_STATUSES = new Set(['BOOKED', 'ALLOTTED', 'REGISTERED']);

const STATUS_STYLE: Record<string, string> = {
  PAID: 'bg-emerald-50 text-emerald-700',
  PARTIAL: 'bg-amber-50 text-amber-700',
  UNPAID: 'bg-slate-100 text-slate-600',
};

export default function InstallmentSchedule() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const [showHistory, setShowHistory] = useState(false);
  const wizardInterestError = (useLocation().state as { interestError?: string } | null)?.interestError;
  const qc = useQueryClient();

  const { data: versions, isLoading } = useQuery<PlanVersion[]>({
    queryKey: ['plan-history', bookingId],
    queryFn: () => api(`/bookings/${bookingId}/plan-history`),
    enabled: !!bookingId,
  });

  const { data: booking } = useQuery<BookingRow>({
    queryKey: ['booking', bookingId],
    queryFn: () => api(`/bookings/${bookingId}`),
    enabled: !!bookingId,
  });

  const [accruing, setAccruing] = useState(false);
  const [accrueMessage, setAccrueMessage] = useState('');

  async function accrueCommission() {
    setAccruing(true);
    setAccrueMessage('');
    try {
      await api(`/bookings/${bookingId}/commission/accrue`, { method: 'POST' });
      setAccrueMessage('Commission accrued.');
    } catch (err) {
      setAccrueMessage((err as Error).message);
    } finally {
      setAccruing(false);
    }
  }

  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelMessage, setCancelMessage] = useState('');

  async function cancelBooking() {
    setCancelling(true);
    setCancelMessage('');
    try {
      await api(`/bookings/${bookingId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ cancellationType: 'CANCEL', reason: cancelReason || undefined }),
      });
      setCancelMessage('Booking cancelled.');
      qc.invalidateQueries({ queryKey: ['booking', bookingId] });
      qc.invalidateQueries({ queryKey: ['plan-history', bookingId] });
    } catch (err) {
      setCancelMessage((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  const active = versions?.find((v) => v.isActive) ?? versions?.[0];
  const dues = (active?.installments ?? []).reduce(
    (sum, i) => sum + (BigInt(i.amountPaise) - BigInt(i.allocatedPaise)),
    0n,
  );

  const columns: Column<Installment>[] = [
    { key: 'seq', header: '#', render: (i) => i.seq },
    { key: 'label', header: 'Installment', render: (i) => i.label },
    {
      key: 'dueDate',
      header: 'Due Date',
      // new Date(null) silently resolves to 1970-01-01 in JavaScript — it
      // does NOT throw — so this branch is not defensive decoration, it's
      // the actual fix. See docs/plans/construction-linked-demand-fix.md
      // §2, consumer #10.
      render: (i) =>
        i.dueDate ? (
          new Date(i.dueDate).toLocaleDateString('en-IN')
        ) : (
          <span className="italic text-slate-400">Not yet due — awaiting stage completion</span>
        ),
    },
    { key: 'amount', header: 'Amount', className: 'text-right', render: (i) => formatInr(BigInt(i.amountPaise)) },
    { key: 'allocated', header: 'Received', className: 'text-right', render: (i) => formatInr(BigInt(i.allocatedPaise)) },
    {
      key: 'due',
      header: 'Due',
      className: 'text-right',
      render: (i) => formatInr(BigInt(i.amountPaise) - BigInt(i.allocatedPaise)),
    },
    {
      key: 'status',
      header: 'Status',
      render: (i) => (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[i.status] ?? ''}`}>
          {i.status}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Installment Schedule</h1>
        {versions && versions.length > 1 && (
          <button
            onClick={() => setShowHistory((s) => !s)}
            className="text-sm font-medium text-blue-600 hover:text-blue-800"
          >
            {showHistory ? 'Hide' : 'Show'} plan version history ({versions.length})
          </button>
        )}
      </div>

      {active && (
        <div className="mt-2 flex gap-6 text-sm text-slate-600">
          <span>Plan: <strong>{active.name}</strong> (v{active.version})</span>
          <span>Total due: <strong className={dues > 0n ? 'text-red-600' : 'text-emerald-600'}>{formatInr(dues)}</strong></span>
        </div>
      )}

      {booking && bookingId && (
        <InterestRulePanel
          bookingId={bookingId}
          status={booking.status}
          interestRuleId={booking.interestRuleId}
          interestFromDate={booking.interestFromDate}
          wizardError={wizardInterestError}
        />
      )}

      {booking?.brokerId && (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={accrueCommission}
            disabled={accruing}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {accruing ? 'Accruing…' : 'Accrue Broker Commission'}
          </button>
          {accrueMessage && <span className="text-sm text-slate-600">{accrueMessage}</span>}
        </div>
      )}

      {booking && CANCELABLE_STATUSES.has(booking.status) && (
        <div className="mt-4 flex items-center gap-3">
          <input
            type="text"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Cancellation reason (optional)"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            onClick={cancelBooking}
            disabled={cancelling}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel Booking'}
          </button>
          {cancelMessage && <span className="text-sm text-slate-600">{cancelMessage}</span>}
        </div>
      )}

      {booking?.status === 'CANCELLED' && (
        <div className="mt-4 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-600">
          This booking has been cancelled.
        </div>
      )}

      <div className="mt-4">
        <DataTable
          columns={columns}
          data={active?.installments ?? []}
          isLoading={isLoading}
          emptyText="No payment plan created yet for this booking."
        />
      </div>

      {showHistory && versions && versions.length > 1 && (
        <div className="mt-6 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">Earlier versions</h2>
          {versions
            .filter((v) => v.id !== active?.id)
            .map((v) => (
              <div key={v.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-sm text-slate-600">
                  {v.name} (v{v.version}) — created {new Date(v.createdAt).toLocaleString()}
                </div>
                <DataTable columns={columns} data={v.installments} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
