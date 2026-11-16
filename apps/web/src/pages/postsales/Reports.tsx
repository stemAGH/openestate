import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS } from '@openestate/shared';
import { api, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';

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

// perm: the permission the report's endpoint requires; a role is offered only the reports it may open.
const REPORT_TYPES = [
  { key: 'collection-summary', label: 'Collection summary', csv: false, perm: PERMISSIONS.REPORTS_COLLECTION_VIEW },
  { key: 'collection-daily', label: 'Collection — daily', csv: true, perm: PERMISSIONS.REPORTS_COLLECTION_VIEW },
  { key: 'collection-monthly', label: 'Collection — monthly', csv: true, perm: PERMISSIONS.REPORTS_COLLECTION_VIEW },
  { key: 'collection-detail', label: 'Collection — detail (per receipt)', csv: true, perm: PERMISSIONS.REPORTS_COLLECTION_VIEW },
  { key: 'unit-status', label: 'Units: sold vs available', csv: false, perm: PERMISSIONS.REPORTS_SALES_VIEW },
  { key: 'booking-status', label: 'Bookings: registered vs allotted', csv: false, perm: PERMISSIONS.REPORTS_SALES_VIEW },
  { key: 'project-rollup', label: 'Project-wise rollup', csv: true, perm: PERMISSIONS.REPORTS_SALES_VIEW },
  { key: 'company-rollup', label: 'Company-wide rollup', csv: false, perm: PERMISSIONS.REPORTS_SALES_VIEW },
  { key: 'birthday-list', label: 'Birthday list (next 30 days)', csv: true, perm: PERMISSIONS.REPORTS_BIRTHDAY_VIEW },
  { key: 'zero-gst-bookings', label: 'Zero-GST bookings (no rate on base line)', csv: true, perm: PERMISSIONS.REPORTS_SALES_VIEW },
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
  const { hasPermission } = useAuth();
  const offered = REPORT_TYPES.filter((r) => hasPermission(r.perm));
  const [chosen, setReportKey] = useState<ReportKey | null>(null);
  const reportKey: ReportKey | undefined = chosen ?? offered[0]?.key;
  const meta = REPORT_TYPES.find((r) => r.key === reportKey);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['report', reportKey],
    queryFn: () => api(ENDPOINTS[reportKey!]),
    enabled: !!reportKey,
    retry: false,
  });

  async function exportCsv() {
    const format = reportKey === 'project-rollup' ? 'csv' : 'csv';
    if (!reportKey) return;
    await downloadFile(`${ENDPOINTS[reportKey]}?format=${format}`, CSV_FILENAME[reportKey]);
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Reports</h1>
        {meta?.csv && (
          <button onClick={exportCsv} className="btn btn-sm btn-secondary">
            Export CSV
          </button>
        )}
      </div>

      <select
        aria-label="Report"
        value={reportKey ?? ''}
        onChange={(e) => setReportKey(e.target.value as ReportKey)}
        className="mt-4 block w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {offered.map((r) => (
          <option key={r.key} value={r.key}>{r.label}</option>
        ))}
      </select>

      <div className="mt-6">
        {!reportKey ? (
          <p className="text-sm text-slate-500">Your role has no reports here.</p>
        ) : isError ? (
          <p role="alert" className="text-sm text-red-700">This report couldn&apos;t load. Try again, or ask an administrator.</p>
        ) : isLoading ? (
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
