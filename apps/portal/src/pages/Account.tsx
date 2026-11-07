import { useQuery } from '@tanstack/react-query';
import { formatInr } from '@openestate/shared';
import { api, downloadFile } from '../lib/api';

interface CostLine {
  id: string;
  label: string;
  lineTotalPaise: string;
}

interface Installment {
  id: string;
  label: string;
  /** Null for an unraised STAGE_LINKED installment. */
  dueDate: string | null;
  amountPaise: string;
  allocatedPaise: string;
  status: string;
}

interface Receipt {
  id: string;
  receiptNumber: string;
  receiptDate: string;
  mode: string;
  grossAmountPaise: string;
}

interface AccountEntry {
  bookingId: string;
  bookingNumber: string;
  agreedPricePaise: string;
  balancePaise: string;
  costLines: CostLine[];
  paymentSchedule: Installment[];
  paymentHistory: Receipt[];
  nextDue: { installmentId: string; label: string; dueDate: string; amountPaise: string } | null;
}

interface GeneratedDocument {
  id: string;
  documentType: string;
  originalName: string;
  createdAt: string;
}

export default function Account() {
  const { data, isLoading } = useQuery<AccountEntry[]>({
    queryKey: ['portal', 'account'],
    queryFn: () => api('/portal/account'),
  });
  const { data: documents } = useQuery<GeneratedDocument[]>({
    queryKey: ['portal', 'account', 'documents'],
    queryFn: () => api('/portal/account/documents'),
  });

  if (isLoading) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (!data || data.length === 0) {
    return <div className="text-slate-500 text-sm">No bookings found on your account yet.</div>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">My Account</h1>

      {data.map((b) => (
        <div key={b.bookingId} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-slate-900 truncate min-w-0">{b.bookingNumber}</span>
            <span className="text-sm text-slate-600 shrink-0">
              Balance {formatInr(BigInt(b.balancePaise))}
            </span>
          </div>

          {b.nextDue && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm">
              <span className="font-medium text-amber-800">Next due: {b.nextDue.label}</span>
              <div className="text-amber-700 mt-0.5">
                {formatInr(BigInt(b.nextDue.amountPaise))} on{' '}
                {new Date(b.nextDue.dueDate).toLocaleDateString('en-IN')}
              </div>
            </div>
          )}

          <details className="text-sm">
            <summary className="cursor-pointer text-slate-700 font-medium">
              Cost breakup ({formatInr(BigInt(b.agreedPricePaise))})
            </summary>
            <ul className="mt-2 space-y-1 text-slate-600">
              {b.costLines.map((l) => (
                <li key={l.id} className="flex justify-between gap-2 flex-wrap">
                  <span>{l.label}</span>
                  <span>{formatInr(BigInt(l.lineTotalPaise))}</span>
                </li>
              ))}
            </ul>
          </details>

          <details className="text-sm">
            <summary className="cursor-pointer text-slate-700 font-medium">
              Payment plan ({b.paymentSchedule.length} installments)
            </summary>
            <ul className="mt-2 space-y-1 text-slate-600">
              {b.paymentSchedule.map((i) => (
                <li key={i.id} className="flex justify-between gap-2 flex-wrap">
                  <span>
                    {i.label} ·{' '}
                    {/* new Date(null) silently resolves to 1970-01-01 in
                        JS rather than throwing — this branch is the fix,
                        not decoration. See
                        internal plan construction-linked-demand-fix.md §2. */}
                    {i.dueDate ? new Date(i.dueDate).toLocaleDateString('en-IN') : 'not yet due'}
                  </span>
                  <span className={i.status === 'PAID' ? 'text-green-600' : ''}>
                    {formatInr(BigInt(i.amountPaise))} ({i.status})
                  </span>
                </li>
              ))}
            </ul>
          </details>

          <details className="text-sm">
            <summary className="cursor-pointer text-slate-700 font-medium">
              Payment history ({b.paymentHistory.length} receipts)
            </summary>
            <ul className="mt-2 space-y-1 text-slate-600">
              {b.paymentHistory.map((r) => (
                <li key={r.id} className="flex justify-between gap-2 flex-wrap">
                  <span>
                    {r.receiptNumber} · {new Date(r.receiptDate).toLocaleDateString('en-IN')} ({r.mode})
                  </span>
                  <span>{formatInr(BigInt(r.grossAmountPaise))}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ))}

      {documents && documents.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="font-medium text-slate-900">Documents</h2>
          <ul className="mt-2 divide-y divide-slate-100">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-700">
                  {d.documentType.replace('_', ' ')} · {new Date(d.createdAt).toLocaleDateString('en-IN')}
                </span>
                <button
                  onClick={() => void downloadFile(`/portal/account/documents/${d.id}/download`, d.originalName)}
                  className="text-blue-600 text-sm font-medium"
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
