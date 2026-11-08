import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS } from '@openestate/shared';
import { useAuth } from '../../lib/auth';
import { api, downloadFile } from '../../lib/api';
import { toast } from '../../lib/toast';
import DataTable, { type Column } from '../../components/DataTable';
import { BarChart, DonutChart } from '../../components/charts/SvgCharts';
import { REPORT_CATALOGUE, REPORT_CATEGORIES, type ReportDef, type ReportCategory } from './reportCatalogue';

interface Project {
  id: string;
  name: string;
}
interface UserOption {
  id: string;
  name: string;
}

type Row = Record<string, unknown> & { id: string };

function toRows(reportDef: ReportDef, data: unknown[] | undefined): Row[] {
  if (!data) return [];
  return data.map((raw, i) => {
    if (reportDef.rowShape === 'array') {
      const arr = raw as unknown[];
      const row: Row = { id: String(i) };
      reportDef.columns.forEach((c) => {
        row[c.key] = arr[Number(c.key)];
      });
      return row;
    }
    return { id: String(i), ...(raw as Record<string, unknown>) };
  });
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export default function PresalesReportsPage() {
  const { hasPermission } = useAuth();
  const canExport = hasPermission(PERMISSIONS.PRESALES_REPORT_EXPORT);
  const canPrint = hasPermission(PERMISSIONS.PRESALES_REPORT_PRINT);

  const [category, setCategory] = useState<ReportCategory>('Lead Reports');
  const reportsInCategory = useMemo(() => REPORT_CATALOGUE.filter((r) => r.category === category), [category]);
  const [reportKey, setReportKey] = useState<string>(reportsInCategory[0]?.key ?? REPORT_CATALOGUE[0].key);
  const reportDef = REPORT_CATALOGUE.find((r) => r.key === reportKey) ?? REPORT_CATALOGUE[0];

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [projectId, setProjectId] = useState('');
  const [executiveId, setExecutiveId] = useState('');
  const [view, setView] = useState<'table' | 'chart'>('table');

  const { data: projects } = useQuery<{ data: Project[] }>({
    queryKey: ['projects-for-report-filter'],
    queryFn: () => api('/projects?limit=100'),
    enabled: !!reportDef.filters.project,
  });
  const { data: users } = useQuery<{ data: UserOption[] }>({
    queryKey: ['users-for-report-filter'],
    queryFn: () => api('/users?page=1&limit=100'),
    enabled: !!reportDef.filters.executive,
  });

  function buildParams(format?: 'csv') {
    const params = new URLSearchParams();
    if (reportDef.filters.dateRange) {
      if (from) params.set('from', from);
      if (to) params.set('to', to);
    }
    if (reportDef.filters.project && projectId) params.set('projectId', projectId);
    if (reportDef.filters.executive && executiveId) params.set('executiveId', executiveId);
    if (format) params.set('format', format);
    return params.toString();
  }

  const query = buildParams();
  const { data, isLoading } = useQuery<unknown[]>({
    queryKey: ['presales-report', reportKey, query],
    queryFn: () => api(`${reportDef.endpoint}${query ? `?${query}` : ''}`),
  });

  const rows = useMemo(() => toRows(reportDef, data), [reportDef, data]);

  function selectCategory(next: ReportCategory) {
    setCategory(next);
    const first = REPORT_CATALOGUE.find((r) => r.category === next);
    if (first) setReportKey(first.key);
    setView('table');
  }

  async function handleExport() {
    const qs = buildParams('csv');
    await downloadFile(`${reportDef.endpoint}?${qs}`, `${reportDef.key}.csv`);
  }

  async function handlePrint() {
    try {
      await api('/reports/presales/audit-action', {
        method: 'POST',
        body: JSON.stringify({
          reportKey: reportDef.key,
          filters: { from, to, projectId, executiveId },
          rowCount: rows.length,
        }),
      });
    } catch {
      toast.error('Could not record the print action — printing cancelled.');
      return;
    }
    window.print();
  }

  const columns: Column<Row>[] = reportDef.columns.map((c) => ({
    key: c.key,
    header: c.header,
    render: (row) => formatCell(row[c.key]),
  }));

  const chartPoints =
    reportDef.chart && !isLoading
      ? rows.map((r) => ({
          label: formatCell(r[reportDef.chart!.labelKey]),
          value: Number(r[reportDef.chart!.valueKey]) || 0,
        }))
      : [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">Pre-Sales Reports</h1>
        <div className="flex gap-2 print:hidden">
          {canExport && (
            <button
              onClick={handleExport}
              className="btn btn-sm btn-secondary"
            >
              Export CSV
            </button>
          )}
          {canPrint && (
            <button
              onClick={handlePrint}
              className="btn btn-sm btn-secondary"
            >
              Print
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 print:hidden">
        {REPORT_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => selectCategory(cat)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              category === cat ? 'bg-blue-600 text-white' : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <select
        aria-label="Report"
        value={reportKey}
        onChange={(e) => {
          setReportKey(e.target.value);
          setView('table');
        }}
        className="mt-3 block w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 print:hidden"
      >
        {reportsInCategory.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>

      {/* FilterBar — one shared shape reused by every report, just showing the fields this report declares it needs. */}
      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4 print:hidden">
        {reportDef.filters.dateRange && (
          <>
            <label className="text-xs text-slate-600">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-600">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          </>
        )}
        {!reportDef.filters.dateRange && (
          <p className="text-xs text-slate-500">This report is a live gauge — it always reflects right now, regardless of any date range.</p>
        )}
        {reportDef.filters.project && (
          <label className="text-xs text-slate-600">
            Project
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">All projects</option>
              {projects?.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {reportDef.filters.executive && (
          <label className="text-xs text-slate-600">
            Executive
            <select
              value={executiveId}
              onChange={(e) => setExecutiveId(e.target.value)}
              className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">All executives</option>
              {users?.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {reportDef.chart && (
          <div className="ml-auto flex gap-1">
            <button
              onClick={() => setView('table')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === 'table' ? 'bg-slate-800 text-white' : 'border border-slate-300 text-slate-700'}`}
            >
              Table
            </button>
            <button
              onClick={() => setView('chart')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${view === 'chart' ? 'bg-slate-800 text-white' : 'border border-slate-300 text-slate-700'}`}
            >
              Chart
            </button>
          </div>
        )}
      </div>

      <div className="mt-6">
        {view === 'chart' && reportDef.chart ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6">
            {reportDef.chart.type === 'bar' ? <BarChart data={chartPoints} /> : <DonutChart data={chartPoints} />}
          </div>
        ) : (
          <DataTable columns={columns} data={rows} isLoading={isLoading} />
        )}
      </div>
    </div>
  );
}
