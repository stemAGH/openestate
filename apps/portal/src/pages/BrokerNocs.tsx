import { formatDate } from '@openestate/shared';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Noc {
  id: string;
  bookingNumber: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
}

export default function BrokerNocs() {
  const qc = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading } = useQuery<Noc[]>({
    queryKey: ['portal', 'broker', 'nocs'],
    queryFn: () => api('/portal/broker/nocs'),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api(`/portal/broker/nocs/${id}/approve`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', 'broker', 'nocs'] }),
  });

  const reject = useMutation({
    mutationFn: (id: string) =>
      api(`/portal/broker/nocs/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      setRejectingId(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['portal', 'broker', 'nocs'] });
    },
  });

  if (isLoading) return <div className="text-slate-600 text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">NOCs</h1>

      {data && data.length === 0 && <div className="text-slate-600 text-sm">No NOC requests yet.</div>}

      <div className="space-y-2">
        {data?.map((n) => (
          <div key={n.id} className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-900 truncate min-w-0">{n.bookingNumber ?? '—'}</span>
              <span
                className={`text-xs rounded-full px-2 py-0.5 shrink-0 ${
                  n.status === 'APPROVED'
                    ? 'bg-green-100 text-green-700'
                    : n.status === 'REJECTED'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-slate-100 text-slate-600'
                }`}
              >
                {n.status}
              </span>
            </div>
            <span className="block text-xs text-slate-400">
              {formatDate(n.createdAt)}
            </span>
            {n.reason && <p className="text-sm text-slate-600">{n.reason}</p>}

            {n.status === 'REQUESTED' && (
              <div className="pt-2 border-t border-slate-100 space-y-2">
                {rejectingId === n.id ? (
                  <>
                    <textarea
                      placeholder="Reason for rejection"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={2}
                      className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => reject.mutate(n.id)}
                        disabled={reject.isPending || !reason.trim()}
                        className="flex-1 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Confirm reject
                      </button>
                      <button
                        onClick={() => {
                          setRejectingId(null);
                          setReason('');
                        }}
                        className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => approve.mutate(n.id)}
                      disabled={approve.isPending}
                      className="flex-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => setRejectingId(n.id)}
                      className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
