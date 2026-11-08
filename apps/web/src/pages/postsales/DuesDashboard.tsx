import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AGEING_BUCKETS } from '@openestate/shared';
import { api, downloadFile } from '../../lib/api';

interface AgeingRow {
  bucket: string;
  count: number;
}

// The installment-dues report yields plain tuples (same array shape used for
// its CSV rows), not objects — [bookingNumber, applicantName, label, dueDate,
// outstandingFormatted, overdueDays, accruedInterestFormatted?].
type DueRow = string[];

interface ProjectRow {
  id: string;
  name: string;
}

const BUCKET_COLOR: Record<string, string> = {
  '0-7': 'bg-emerald-50 text-emerald-700',
  '8-30': 'bg-amber-50 text-amber-700',
  '31-90': 'bg-orange-50 text-orange-700',
  '90+': 'bg-red-50 text-red-700',
};

export default function DuesDashboard() {
  const [projectId, setProjectId] = useState('');
  const [withInterest, setWithInterest] = useState(false);

  const { data: projects } = useQuery<{ data: ProjectRow[] }>({
    queryKey: ['projects-all'],
    queryFn: () => api('/projects?limit=100'),
  });

  const { data: ageing } = useQuery<AgeingRow[]>({
    queryKey: ['dues-ageing', projectId],
    queryFn: () => api(`/reports/postsales/dues-ageing${projectId ? `?projectId=${projectId}` : ''}`),
  });

  const { data: dues, isLoading } = useQuery<DueRow[]>({
    queryKey: ['installment-dues', projectId, withInterest],
    queryFn: () =>
      api(
        `/reports/postsales/installment-dues${withInterest ? '-with-interest' : ''}${projectId ? `?projectId=${projectId}` : ''}`,
      ),
  });

  async function exportCsv() {
    const qs = new URLSearchParams({ format: 'csv', ...(projectId ? { projectId } : {}) }).toString();
    await downloadFile(
      `/reports/postsales/installment-dues${withInterest ? '-with-interest' : ''}?${qs}`,
      'installment-dues.csv',
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Dues Dashboard</h1>
        <button onClick={exportCsv} className="btn btn-sm btn-secondary">
          Export CSV
        </button>
      </div>

      <div className="mt-4 flex items-center gap-4">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All projects</option>
          {projects?.data?.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input type="checkbox" checked={withInterest} onChange={(e) => setWithInterest(e.target.checked)} />
          Show accrued interest
        </label>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {AGEING_BUCKETS.map((bucket) => {
          const row = ageing?.find((a) => a.bucket === bucket);
          return (
            <div key={bucket} className={`rounded-lg p-4 ${BUCKET_COLOR[bucket]}`}>
              <div className="text-xs font-medium uppercase tracking-wide">{bucket} days</div>
              <div className="mt-1 text-2xl font-semibold">{row?.count ?? 0}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              {['Booking', 'Applicant', 'Installment', 'Due Date', 'Outstanding', 'Overdue Days', ...(withInterest ? ['Accrued Interest'] : [])].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {isLoading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">Loading…</td></tr>
            ) : !dues || dues.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">No outstanding dues.</td></tr>
            ) : (
              dues.map((d, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-sm text-slate-700">{d[0]}</td>
                  <td className="px-4 py-3 text-sm text-slate-700">{d[1]}</td>
                  <td className="px-4 py-3 text-sm text-slate-700">{d[2]}</td>
                  <td className="px-4 py-3 text-sm text-slate-700">{d[3]}</td>
                  <td className="px-4 py-3 text-sm text-slate-700 text-right">{d[4]}</td>
                  <td className="px-4 py-3 text-sm text-slate-700 text-right">{d[5]}</td>
                  {withInterest && <td className="px-4 py-3 text-sm text-slate-700 text-right">{d[6]}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
