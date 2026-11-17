import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatInr, PERMISSIONS } from '@openestate/shared';
import { usePaginatedQuery } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import Pagination from '../../components/Pagination';
import { Card, EmptyState, PageHeader } from '../../ui';

interface BookingRow {
  id: string;
  bookingNumber: string;
  status: string;
  bookingDate: string;
  agreedPricePaise: string;
  balancePaise: string;
  applicant: { id: string; name: string; primaryPhone: string };
  unit: { label: string };
  project: { id: string; name: string } | null;
}

const STATUSES = ['BOOKED', 'ALLOTTED', 'REGISTERED', 'CANCELLED', 'SURRENDERED', 'TRANSFERRED_OUT'];

function Balance({ paise }: { paise: string }) {
  const v = BigInt(paise);
  if (v === 0n) return <span className="text-slate-600">Settled</span>;
  return v > 0n ? <span>{formatInr(v)} due</span> : <span className="text-emerald-800">{formatInr(-v)} owed back</span>;
}

/** Bookings the user may see (their team's, or the company's for finance and admin roles), with the outstanding balance. */
export default function BookingsPage() {
  const { hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const params: Record<string, string | number> = { page, limit: 20, ...(search.trim().length >= 2 ? { search: search.trim() } : {}), ...(status ? { status } : {}) };
  const { data, isLoading, isError } = usePaginatedQuery<BookingRow>(['bookings'], '/bookings', params);
  const can360 = hasPermission(PERMISSIONS.PRESALES_APPLICANT_READ);

  return (
    <div>
      <PageHeader title="Bookings" description={data ? `${data.meta.total} booking${data.meta.total === 1 ? '' : 's'}` : undefined} />
      <div className="mt-4 flex flex-wrap items-center gap-2" role="search">
        <input
          type="search"
          aria-label="Search bookings by booking number, name or phone"
          placeholder="Booking number, name or phone"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="input h-9 w-full sm:w-72"
        />
        <label htmlFor="booking-status" className="sr-only">Status</label>
        <select id="booking-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="input h-9 w-auto">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
        </select>
      </div>
      <Card className="mt-4 overflow-x-auto">
        {isLoading ? (
          <p className="p-4 text-sm text-slate-600">Loading…</p>
        ) : isError ? (
          <p className="p-4 text-sm text-red-700">Bookings couldn&apos;t be loaded.</p>
        ) : !data?.data.length ? (
          <EmptyState message="No bookings match." />
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-slate-600">
                <th className="px-4 py-2">Booking</th>
                <th className="px-4 py-2">Applicant</th>
                <th className="px-4 py-2">Project / unit</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Booked on</th>
                <th className="px-4 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((b) => (
                <tr key={b.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    <Link to={`/postsales/bookings/${b.id}/installments`} className="font-medium text-blue-700 hover:underline">
                      {b.bookingNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {can360 ? (
                      <Link to={`/postsales/applicants/${b.applicant.id}`} className="text-blue-700 hover:underline">{b.applicant.name}</Link>
                    ) : (
                      b.applicant.name
                    )}
                    <div className="text-xs text-slate-600">{b.applicant.primaryPhone}</div>
                  </td>
                  <td className="px-4 py-2">{b.project?.name ?? '—'} · {b.unit.label}</td>
                  <td className="px-4 py-2">{b.status.replace('_', ' ').toLowerCase()}</td>
                  <td className="px-4 py-2">{formatDate(b.bookingDate)}</td>
                  <td className="px-4 py-2 text-right"><Balance paise={b.balancePaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {data && <Pagination page={page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
    </div>
  );
}
