import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloadFile } from '../../lib/api';

interface StatusCount {
  status: string;
  count: number;
}

interface ProjectRollupRow {
  projectId: string;
  projectName: string;
  totalUnits: number;
  bookedOrBeyond: number;
  collectedFormatted: string;
}

interface CompanyRollup {
  totalUnits: number;
  soldOrBeyond: number;
  availableOrHeld: number;
  totalCollectedFormatted: string;
}

interface CollectionSummary {
  totalReceipts: number;
  totalCollectedFormatted: string;
}

type TupleRows = string[][];

const REPORT_TYPES = [
  { key: 'collection-summary', label: 'Collection summary', csv: false },
  { key: 'collection-daily', label: 'Collection — daily', csv: true },
  { key: 'collection-monthly', label: 'Collection — monthly', csv: true },
  { key: 'collection-detail', label: 'Collection — detail (per receipt)', csv: true },
  { key: 'unit-status', label: 'Units: sold vs available', csv: false },
  { key: 'booking-status', label: 'Bookings: registered vs allotted', csv: false },
  { key: 'project-rollup', label: 'Project-wise rollup', csv: true },
  { key: 'company-rollup', label: 'Company-wide rollup', csv: false },
  { key: 'birthday-list', label: 'Birthday list (next 30 days)', csv: true },
  { key: 'zero-gst-bookings', label: 'Zero-GST bookings (no rate on base line)', csv: true },
] as const;

type ReportKey = (typeof REPORT_TYPES)[number]['key'];

const ENDPOINTS: Record<ReportKey, string> = {
  'collection-summary': '/reports/postsales/collection/summary',
  'collection-daily': '/reports/postsales/collection/daily',
  'collection-monthly': '/reports/postsales/collection/monthly',
  'collection-detail': '/reports/postsales/collection/detail',
  'unit-status': '/reports/postsales/units/status-rollup',
  'booking-status': '/reports/postsales/bookings/status-rollup',
  'project-rollup': '/reports/postsales/project-rollup',
  'company-rollup': '/reports/postsales/company-rollup',
  'birthday-list': '/reports/postsales/birthday-list',
  'zero-gst-bookings': '/reports/postsales/zero-gst-bookings',
};

const CSV_FILENAME: Record<ReportKey, string> = {
  'collection-summary': 'collection-summary.csv',
  'collection-daily': 'collection-daily.csv',
  'collection-monthly': 'collection-monthly.csv',
  'collection-detail': 'collection-detail.csv',
  'unit-status': 'unit-status.csv',
  'booking-status': 'booking-status.csv',
  'project-rollup': 'project-rollup.csv',
  'company-rollup': 'company-rollup.csv',
  'birthday-list': 'birthday-list.csv',
  'zero-gst-bookings': 'zero-gst-bookings.csv',
};

export default function ReportsPage() {
  const [reportKey, setReportKey] = useState<ReportKey>('collection-summary');
  const meta = REPORT_TYPES.find((r) => r.key === reportKey)!;

  const { data, isLoading } = useQuery({
    queryKey: ['report', reportKey],
    queryFn: () => api(ENDPOINTS[reportKey]),
  });

  async function exportCsv() {
    const format = reportKey === 'project-rollup' ? 'csv' : 'csv';
    await downloadFile(`${ENDPOINTS[reportKey]}?format=${format}`, CSV_FILENAME[reportKey]);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Reports</h1>
        {meta.csv && (
          <button onClick={exportCsv} className="btn btn-sm btn-secondary">
            Export CSV
          </button>
        )}
      </div>

      <select
        value={reportKey}
        onChange={(e) => setReportKey(e.target.value as ReportKey)}
        className="mt-4 block w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {REPORT_TYPES.map((r) => (
          <option key={r.key} value={r.key}>{r.label}</option>
        ))}
      </select>

      <div className="mt-6">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <ReportBody reportKey={reportKey} data={data} />
        )}
      </div>
    </div>
  );
}

function ReportBody({ reportKey, data }: { reportKey: ReportKey; data: unknown }) {
  if (reportKey === 'company-rollup') {
    const d = data as CompanyRollup;
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total units" value={d.totalUnits} />
        <Stat label="Sold or beyond" value={d.soldOrBeyond} />
        <Stat label="Available/held" value={d.availableOrHeld} />
        <Stat label="Total collected" value={d.totalCollectedFormatted} />
      </div>
    );
  }

  if (reportKey === 'collection-summary') {
    const d = data as CollectionSummary;
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Total receipts" value={d.totalReceipts} />
        <Stat label="Total collected" value={d.totalCollectedFormatted} />
      </div>
    );
  }

  if (reportKey === 'unit-status' || reportKey === 'booking-status') {
    const rows = data as StatusCount[];
    return <SimpleTable headers={['Status', 'Count']} rows={rows.map((r) => [r.status, String(r.count)])} />;
  }

  if (reportKey === 'project-rollup') {
    const rows = data as ProjectRollupRow[];
    return (
      <SimpleTable
        headers={['Project', 'Total Units', 'Booked+', 'Collected']}
        rows={rows.map((r) => [r.projectName, String(r.totalUnits), String(r.bookedOrBeyond), r.collectedFormatted])}
      />
    );
  }

  if (reportKey === 'collection-daily' || reportKey === 'collection-monthly') {
    return <SimpleTable headers={['Period', 'Total']} rows={data as TupleRows} />;
  }

  if (reportKey === 'collection-detail') {
    return (
      <SimpleTable
        headers={['Receipt #', 'Date', 'Booking', 'Applicant', 'Mode', 'Amount']}
        rows={data as TupleRows}
      />
    );
  }

  if (reportKey === 'birthday-list') {
    return (
      <SimpleTable headers={['Name', 'Phone', 'Birthday (MM-DD)', 'Days Away']} rows={data as TupleRows} />
    );
  }

  if (reportKey === 'zero-gst-bookings') {
    return (
      <SimpleTable headers={['Booking #', 'Applicant', 'Unit', 'Booking Date']} rows={data as TupleRows} />
    );
  }

  return null;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} className="px-4 py-8 text-center text-sm text-slate-500">No data.</td></tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className="hover:bg-slate-50">
                {row.map((cell, j) => (
                  <td key={j} className="px-4 py-3 text-sm text-slate-700">{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
