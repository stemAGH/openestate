import { useState } from 'react';
import { formatInr } from '@openestate/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';

interface ChequeReceipt {
  id: string;
  receiptNumber: string;
  receiptDate: string;
  mode: string;
  grossAmountPaise: string;
  clearanceStatus: string;
  instrumentNumber: string | null;
  booking: { bookingNumber: string; primaryApplicant: { name: string } };
}

const STATUS_FLOW: Record<string, string> = {
  RECEIVED: 'DEPOSITED',
  DEPOSITED: 'CLEARED',
};

const STATUS_STYLE: Record<string, string> = {
  RECEIVED: 'bg-slate-100 text-slate-600',
  DEPOSITED: 'bg-amber-50 text-amber-700',
  CLEARED: 'bg-emerald-50 text-emerald-700',
  BOUNCED: 'bg-red-50 text-red-700',
};

export default function ChequeQueue() {
  const [statusFilter, setStatusFilter] = useState('');
  const [bounceReasonFor, setBounceReasonFor] = useState<string | null>(null);
  const [bounceReason, setBounceReason] = useState('');

  const { data, isLoading, refetch } = useQuery<ChequeReceipt[]>({
    queryKey: ['cheque-queue', statusFilter],
    queryFn: () => api(`/receipts/cheque-queue${statusFilter ? `?status=${statusFilter}` : ''}`),
  });

  async function recordEvent(receiptId: string, status: string, reason?: string) {
    await api(`/receipts/${receiptId}/cheque-event`, {
      method: 'POST',
      body: JSON.stringify({ status, eventDate: new Date().toISOString().slice(0, 10), reason }),
    });
    refetch();
  }

  async function advance(receipt: ChequeReceipt) {
    const next = STATUS_FLOW[receipt.clearanceStatus];
    if (!next) return;
    await recordEvent(receipt.id, next);
  }

  async function submitBounce() {
    if (!bounceReasonFor) return;
    await recordEvent(bounceReasonFor, 'BOUNCED', bounceReason || 'Bounced');
    setBounceReasonFor(null);
    setBounceReason('');
  }

  const columns: Column<ChequeReceipt>[] = [
    { key: 'receiptNumber', header: 'Receipt #', render: (r) => r.receiptNumber },
    { key: 'applicant', header: 'Applicant', render: (r) => r.booking.primaryApplicant.name },
    { key: 'booking', header: 'Booking', render: (r) => r.booking.bookingNumber },
    { key: 'mode', header: 'Mode', render: (r) => r.mode },
    { key: 'instrument', header: 'Instrument #', render: (r) => r.instrumentNumber ?? '—' },
    { key: 'amount', header: 'Amount', className: 'text-right', render: (r) => formatInr(BigInt(r.grossAmountPaise)) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.clearanceStatus] ?? ''}`}>
          {r.clearanceStatus}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => (
        <div className="flex justify-end gap-2">
          {STATUS_FLOW[r.clearanceStatus] && (
            <button onClick={() => advance(r)} className="text-xs font-medium text-emerald-600 hover:text-emerald-800">
              Mark {STATUS_FLOW[r.clearanceStatus]}
            </button>
          )}
          {r.clearanceStatus !== 'BOUNCED' && (
            <button onClick={() => setBounceReasonFor(r.id)} className="text-xs font-medium text-red-600 hover:text-red-800">
              Bounce
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <h1 className="page-title">Cheque / DD Verification Queue</h1>

      <div className="mt-4 flex gap-2">
        {['', 'RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED'].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              statusFilter === s ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {s || 'Pending (default)'}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <DataTable columns={columns} data={data ?? []} isLoading={isLoading} emptyText="Nothing awaiting verification." />
      </div>

      {bounceReasonFor && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-sm font-semibold text-slate-900">Record cheque bounce</h2>
            <textarea
              value={bounceReason}
              onChange={(e) => setBounceReason(e.target.value)}
              placeholder="Reason (e.g. insufficient funds)"
              className="mt-3 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              rows={3}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setBounceReasonFor(null)}
                className="btn btn-sm btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={submitBounce}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
              >
                Confirm bounce
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
