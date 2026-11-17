import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS } from '@openestate/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export interface BookingDetailsData {
  id: string;
  remark: string | null;
  primaryApplicantId: string;
  coApplicants: Array<{ applicantId: string; ordinal: number; applicant: { id: string; name: string } }>;
}

interface Found {
  id: string;
  name: string;
  primaryPhone: string;
}

/**
 * Non-financial booking edits on the schedule page (postsales.booking.update):
 * the remark and the co-applicants. Adding a co-applicant asks for a
 * confirmation saying the person's portal account will see the booking.
 */
export default function BookingDetailsCard({ booking, onSaved }: { booking: BookingDetailsData; onSaved: () => void }) {
  const { hasPermission } = useAuth();
  const [remark, setRemark] = useState(booking.remark ?? '');
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<Found | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const canSearch = hasPermission(PERMISSIONS.PRESALES_APPLICANT_READ);
  const co = [...booking.coApplicants].sort((a, b) => a.ordinal - b.ordinal);

  const { data: found } = useQuery<{ data: Found[] }>({
    queryKey: ['coapp-search', search],
    queryFn: () => api(`/applicants?search=${encodeURIComponent(search.trim())}&limit=10`),
    enabled: canSearch && search.trim().length >= 3 && !pending,
  });

  async function call(path: string, method: string, body?: unknown, done?: string) {
    setError('');
    setMessage('');
    try {
      await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (done) setMessage(done);
      onSaved();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }

  const move = (i: number, d: -1 | 1) => {
    const ids = co.map((c) => c.applicantId);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    return call(`/bookings/${booking.id}/co-applicants/order`, 'PUT', { applicantIds: ids });
  };

  return (
    <section aria-labelledby="booking-details-title" className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 id="booking-details-title" className="section-title">Booking details</h2>

      <label htmlFor="booking-remark" className="mt-3 block text-sm font-medium text-slate-700">Remark</label>
      <textarea id="booking-remark" rows={2} maxLength={1000} value={remark} onChange={(e) => setRemark(e.target.value)} className="mt-1 input" />
      <button
        onClick={() => call(`/bookings/${booking.id}`, 'PATCH', { remark: remark.trim() ? remark.trim() : null }, 'Remark saved.')}
        className="btn btn-sm btn-secondary mt-2"
      >
        Save remark
      </button>

      <h3 className="mt-4 text-sm font-medium text-slate-700">Co-applicants</h3>
      {co.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">None.</p>
      ) : (
        <ol className="mt-1 space-y-1 text-sm">
          {co.map((c, i) => (
            <li key={c.applicantId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-40">{c.applicant.name}</span>
              <button onClick={() => move(i, -1)} disabled={i === 0} className="btn btn-sm btn-secondary" aria-label={`Move ${c.applicant.name} up`}>↑</button>
              <button onClick={() => move(i, 1)} disabled={i === co.length - 1} className="btn btn-sm btn-secondary" aria-label={`Move ${c.applicant.name} down`}>↓</button>
              <button
                onClick={() => call(`/bookings/${booking.id}/co-applicants/${c.applicantId}`, 'DELETE', undefined, `${c.applicant.name} removed.`)}
                className="btn btn-sm btn-secondary"
              >
                Remove {c.applicant.name}
              </button>
            </li>
          ))}
        </ol>
      )}

      {canSearch && !pending && (
        <div className="mt-3">
          <label htmlFor="coapp-search" className="block text-sm font-medium text-slate-700">Add a co-applicant</label>
          <input id="coapp-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or phone" className="mt-1 input" />
          {found?.data
            .filter((f) => f.id !== booking.primaryApplicantId && !co.some((c) => c.applicantId === f.id))
            .map((f) => (
              <button key={f.id} onClick={() => setPending(f)} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
                {f.name} — {f.primaryPhone}
              </button>
            ))}
        </div>
      )}

      {pending && (
        <div role="alertdialog" aria-labelledby="coapp-confirm-title" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h3 id="coapp-confirm-title" className="text-sm font-semibold text-amber-900">Add {pending.name} as a co-applicant?</h3>
          <p className="mt-1 text-sm text-amber-900">
            If {pending.name} has a customer portal account, they will be able to see this booking there: its schedule, receipts and
            documents.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              onClick={async () => {
                if (await call(`/bookings/${booking.id}/co-applicants`, 'POST', { applicantId: pending.id, confirmPortalAccess: true }, `${pending.name} added.`)) {
                  setPending(null);
                  setSearch('');
                }
              }}
              className="btn btn-sm btn-primary"
            >
              Yes, add co-applicant
            </button>
            <button onClick={() => setPending(null)} className="btn btn-sm btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      {message && <p role="status" className="mt-2 text-sm text-emerald-800">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
