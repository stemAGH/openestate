import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { INQUIRY_STATUS_LABELS, PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { usePaginatedQuery } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api, downloadFile } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import CustomFieldInputs, {
  useCustomFieldDefinitions,
  buildCustomFieldPayload,
} from '../../components/CustomFieldInputs';
import { ContactActions, FollowUpDue, InquiryStatusBadge, PageHeader, TemperatureBadge } from '../../ui';

interface Inquiry {
  id: string;
  status: string;
  sourceId: string | null;
  preferredUnitTypeId: string | null;
  nextFollowupAt: string | null;
  applicant: { id: string; name: string; primaryPhone: string };
  project: { id: string; name: string } | null;
  temperature: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  createdAt: string;
}

/** What the dashboard returns that this page uses: today's count and the team list for the owner filter. */
interface DashboardLite {
  mine: { followUpsToday: number };
  team: { followUpsToday: number; perReport: Array<{ userId: string; name: string }> } | null;
}

/** The list's URL parameters; each maps 1:1 to a GET /inquiries filter (q → search). */
const FILTER_KEYS = ['status', 'temperatureId', 'projectId', 'followUp', 'assignedToId'] as const;

/** A filter: a native select styled as a pill, highlighted while it narrows the list. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      aria-label={`Filter by ${label.toLowerCase()}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-9 rounded-full border px-3 text-sm ${
        value ? 'border-primary bg-primary-soft font-medium text-primary-fg' : 'border-line-input bg-surface text-fg'
      }`}
    >
      <option value="">{label}: all</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

interface ImportResult {
  success: boolean;
  createdCount: number;
  linkedCount: number;
  flaggedCount: number;
  errorCount: number;
  errors: ImportRowError[];
  linked: Array<{ row: number; applicantName: string; applicantId: string }>;
  flagged: Array<{
    row: number;
    applicantName: string;
    applicantId: string;
    possibleDuplicateOfApplicantId: string;
  }>;
}

interface DuplicateCandidate {
  id: string;
  name: string;
  primaryPhone: string;
}

interface MasterOption {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
}

export default function InquiriesPage() {
  // Filters live in the URL, so dashboard links and the back button work.
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? '1') || 1;
  const filter = (k: string) => params.get(k) ?? '';
  const setFilter = (k: string, v: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v) next.set(k, v);
        else next.delete(k);
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  const setPage = (n: number) => setFilter('page', n > 1 ? String(n) : '');
  const [search, setSearch] = useState(filter('q'));
  // Debounced: the list follows typing without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== filter('q')) setFilter('q', search.trim());
    }, 300);
    return () => clearTimeout(t);
    // Only the typed text restarts the timer.
  }, [search]);
  const anyFilter = FILTER_KEYS.some((k) => filter(k)) || !!filter('q');

  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [newApplicantId, setNewApplicantId] = useState<string | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<DuplicateCandidate[]>([]);
  const [confirmingDistinctId, setConfirmingDistinctId] = useState<string | null>(null);
  const [confirmDistinctError, setConfirmDistinctError] = useState('');
  const [applicantName, setApplicantName] = useState('');
  const [applicantPhone, setApplicantPhone] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [temperatureId, setTemperatureId] = useState('');
  const [inquiryCf, setInquiryCf] = useState<Record<string, unknown>>({});
  const [applicantCf, setApplicantCf] = useState<Record<string, unknown>>({});

  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);

  const { definitions: inquiryDefs } = useCustomFieldDefinitions('INQUIRY');
  const { definitions: applicantDefs } = useCustomFieldDefinitions('APPLICANT');

  const qc = useQueryClient();
  const { user, hasPermission } = useAuth();
  const listParams: Record<string, string | number> = { page, limit: 20 };
  for (const k of FILTER_KEYS) if (filter(k)) listParams[k] = filter(k);
  if (filter('q').length >= 2) listParams.search = filter('q');
  const { data, isLoading, isError } = usePaginatedQuery<Inquiry>(['inquiries'], '/inquiries', listParams);

  // Same request and cache entry as the Dashboard page.
  const { data: dash } = useQuery<DashboardLite>({
    queryKey: ['dashboard'],
    queryFn: () => api('/dashboard'),
    retry: false,
  });
  const dueToday = dash ? (dash.team ?? dash.mine).followUpsToday : null;
  // Owner filter: only for someone with a team, offering exactly that team.
  const owners = dash?.team
    ? [{ value: user?.sub ?? '', label: 'Me' }, ...dash.team.perReport.map((r) => ({ value: r.userId, label: r.name }))]
    : null;

  // v0.4: an empty list here is ambiguous — genuinely no leads, or a
  // manager-tier user whose team just isn't configured yet (TeamScopeService
  // scopes them to their own subtree, which is empty with zero reports).
  // PRESALES_INQUIRY_ASSIGN is a cheap, already-loaded proxy for
  // "manager-tier" (sales_manager+ hold it, sales_executive doesn't) — no
  // extra request unless the list is actually empty for that role.
  const isManagerTier =
    hasPermission(PERMISSIONS.PRESALES_INQUIRY_ASSIGN) &&
    user?.roleSlug !== SYSTEM_ROLES.COMPANY_ADMIN &&
    user?.roleSlug !== SYSTEM_ROLES.SUPER_ADMIN;
  const listIsEmpty = !isLoading && (data?.data.length ?? 0) === 0;
  const { data: reportsCheck } = useQuery({
    queryKey: ['has-reports-check', user?.sub],
    queryFn: () => api<{ data: Array<{ managerId: string | null }> }>('/users?limit=100'),
    // Only a role that can read users asks (no silent 403), and only on an
    // unfiltered empty list, where "no reports configured" is the question.
    enabled: listIsEmpty && isManagerTier && !anyFilter && hasPermission(PERMISSIONS.ADMIN_USER_READ),
  });
  const noReportsConfigured = !!reportsCheck && !reportsCheck.data.some((u) => u.managerId === user?.sub);

  const { data: projects } = useQuery<{ data: Project[] }>({
    queryKey: ['projects', 'all'],
    queryFn: () => api('/projects?limit=100'),
  });
  const { data: sources } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'inquiry-sources', 'all'],
    queryFn: () => api('/masters/inquiry-sources?limit=100'),
  });
  const { data: temperatures } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'inquiry-temperatures', 'all'],
    queryFn: () => api('/masters/inquiry-temperatures?limit=100'),
  });
  const { data: unitTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'unit-types', 'all'],
    queryFn: () => api('/masters/unit-types?limit=100'),
  });
  const nameOf = (list: { data: MasterOption[] } | undefined, id: string | null) =>
    (id && list?.data.find((x) => x.id === id)?.name) || null;

  const handleCreate = async () => {
    setError('');
    setNewApplicantId(null);
    setDuplicateCandidates([]);
    setConfirmDistinctError('');
    try {
      const res = await api<{
        applicantId: string;
        possibleDuplicates?: DuplicateCandidate[];
      }>('/inquiries', {
        method: 'POST',
        body: JSON.stringify({
          applicant: {
            name: applicantName,
            primaryPhone: applicantPhone,
            alternatePhones: [],
            customFields: buildCustomFieldPayload(applicantDefs, applicantCf),
          },
          projectId: projectId === '' ? undefined : projectId,
          sourceId: sourceId === '' ? undefined : sourceId,
          temperatureId: temperatureId === '' ? undefined : temperatureId,
          customFields: buildCustomFieldPayload(inquiryDefs, inquiryCf),
        }),
      });
      if (res.possibleDuplicates && res.possibleDuplicates.length > 0) {
        setNewApplicantId(res.applicantId);
        setDuplicateCandidates(res.possibleDuplicates);
      }
      qc.invalidateQueries({ queryKey: ['inquiries'] });
      setShowForm(false);
      setApplicantName('');
      setApplicantPhone('');
      setProjectId('');
      setSourceId('');
      setTemperatureId('');
      setInquiryCf({});
      setApplicantCf({});
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImportError('');
    setImportResult(null);
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', importFile);
      const res = await api<ImportResult>('/inquiries/import', { method: 'POST', body: form });
      setImportResult(res);
      if (res.success) {
        setImportFile(null);
        qc.invalidateQueries({ queryKey: ['inquiries'] });
      }
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmDistinct = async (otherApplicantId: string) => {
    if (!newApplicantId) return;
    setConfirmDistinctError('');
    setConfirmingDistinctId(otherApplicantId);
    try {
      await api(`/applicants/${newApplicantId}/confirm-distinct`, {
        method: 'POST',
        body: JSON.stringify({ otherApplicantId }),
      });
      setDuplicateCandidates((prev) => prev.filter((c) => c.id !== otherApplicantId));
    } catch (err) {
      setConfirmDistinctError((err as Error).message);
    } finally {
      setConfirmingDistinctId(null);
    }
  };

  const columns: Column<Inquiry>[] = [
    {
      key: 'applicant',
      header: 'Name',
      render: (i) => (
        <span className="flex flex-col leading-tight">
          <Link to={`/presales/inquiries/${i.id}`} className="font-medium text-primary hover:underline">
            {i.applicant.name}
          </Link>
          {nameOf(sources, i.sourceId) && <span className="text-xs text-fg-2">{nameOf(sources, i.sourceId)}</span>}
        </span>
      ),
    },
    { key: 'phone', header: 'Phone', render: (i) => <span className="whitespace-nowrap">{i.applicant.primaryPhone}</span> },
    {
      key: 'interest',
      header: 'Interest',
      render: (i) => (
        <span className="flex flex-col leading-tight">
          <span>{i.project?.name ?? '—'}</span>
          {nameOf(unitTypes, i.preferredUnitTypeId) && (
            <span className="text-xs text-fg-2">{nameOf(unitTypes, i.preferredUnitTypeId)}</span>
          )}
        </span>
      ),
    },
    { key: 'temperature', header: 'Temperature', render: (i) => <TemperatureBadge name={i.temperature?.name} /> },
    { key: 'status', header: 'Status', render: (i) => <InquiryStatusBadge status={i.status} /> },
    { key: 'next', header: 'Next follow-up', render: (i) => <FollowUpDue at={i.nextFollowupAt} /> },
    { key: 'owner', header: 'Owner', render: (i) => i.assignedTo?.name ?? '—' },
    { key: 'contact', header: 'Contact', render: (i) => <ContactActions name={i.applicant.name} inquiryId={i.id} /> },
  ];

  const total = data?.meta?.total;
  const countLine =
    total === undefined
      ? undefined
      : `${total} ${total === 1 ? 'inquiry' : 'inquiries'}${
          dueToday !== null ? ` · ${dueToday} follow-up${dueToday === 1 ? '' : 's'} due today` : ''
        }`;

  return (
    <div>
      <PageHeader
        title="Inquiries"
        description={countLine}
        actions={
          <>
            <button
              onClick={() => downloadFile('/reports/presales/inquiries-export?format=csv', 'inquiries-export.csv')}
              className="btn btn-sm btn-secondary"
            >
              Export CSV
            </button>
            <button onClick={() => setShowImport((v) => !v)} className="btn btn-sm btn-secondary">
              Bulk Import
            </button>
            <button onClick={() => setShowForm(true)} className="btn btn-md btn-primary">
              New inquiry
            </button>
          </>
        }
      />

      <div className="mt-4 flex flex-wrap items-center gap-2" role="search">
        <input
          type="search"
          aria-label="Search inquiries by name, phone or email"
          placeholder="Search name, phone or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input h-9 w-full sm:w-72"
        />
        <FilterSelect
          label="Status"
          value={filter('status')}
          onChange={(v) => setFilter('status', v)}
          options={[
            { value: 'OPEN,CONTINUED', label: 'Active (open or continued)' },
            ...Object.entries(INQUIRY_STATUS_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
        <FilterSelect
          label="Temperature"
          value={filter('temperatureId')}
          onChange={(v) => setFilter('temperatureId', v)}
          options={(temperatures?.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
        />
        <FilterSelect
          label="Project"
          value={filter('projectId')}
          onChange={(v) => setFilter('projectId', v)}
          options={(projects?.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        <FilterSelect
          label="Follow-up"
          value={filter('followUp')}
          onChange={(v) => setFilter('followUp', v)}
          options={[
            { value: 'today', label: 'Due today' },
            { value: 'overdue', label: 'Overdue' },
          ]}
        />
        {owners && (
          <FilterSelect label="Owner" value={filter('assignedToId')} onChange={(v) => setFilter('assignedToId', v)} options={owners} />
        )}
        {anyFilter && (
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setParams(new URLSearchParams(), { replace: true });
            }}
            className="btn btn-sm btn-link"
          >
            Clear filters
          </button>
        )}
      </div>

      {showImport && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-600">
            Upload an XLSX file to create inquiries in bulk — applicant
            phone/email is deduplicated against existing applicants the
            same way it is for a single inquiry.{' '}
            <button
              onClick={() => downloadFile('/inquiries/import-template', 'inquiry-import-template.xlsx')}
              className="font-medium text-blue-600 hover:underline"
            >
              Download template
            </button>
          </p>
          <div className="mt-3 flex items-center gap-3">
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                setImportFile(e.target.files?.[0] ?? null);
                setImportResult(null);
                setImportError('');
              }}
              className="block text-sm text-slate-700"
            />
            <button
              onClick={handleImport}
              disabled={!importFile || importing}
              className="btn btn-md btn-primary"
            >
              {importing ? 'Uploading…' : 'Upload'}
            </button>
          </div>
          {importError && <p className="mt-2 text-sm text-red-600">{importError}</p>}
          {importResult && (
            <div className="mt-3 text-sm">
              {importResult.success ? (
                <p className="text-emerald-700">
                  Created {importResult.createdCount}, linked to an existing applicant{' '}
                  {importResult.linkedCount}
                  {importResult.flaggedCount > 0 && (
                    <>, flagged as a possible duplicate (not linked) {importResult.flaggedCount}</>
                  )}
                  .
                </p>
              ) : (
                <>
                  <p className="font-medium text-red-700">
                    {importResult.errorCount} row error{importResult.errorCount === 1 ? '' : 's'} — nothing was
                    imported. Fix and re-upload.
                  </p>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md bg-red-50 p-2 text-xs text-red-700">
                    {importResult.errors.map((e, idx) => (
                      <li key={idx}>
                        Row {e.row}, {e.field}: {e.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {duplicateCandidates.length > 0 && (
        <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          <p>
            Inquiry created, but {duplicateCandidates.length} possible duplicate applicant(s) were found with the
            same phone/email. If they're genuinely different people, confirm it so this stops warning for this
            pair.
          </p>
          <ul className="mt-2 space-y-1">
            {duplicateCandidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 rounded bg-white px-2 py-1">
                <span>
                  {c.name} — {c.primaryPhone}
                </span>
                {hasPermission(PERMISSIONS.PRESALES_APPLICANT_MERGE) && (
                  <button
                    onClick={() => handleConfirmDistinct(c.id)}
                    disabled={confirmingDistinctId === c.id}
                    className="rounded-md border border-amber-300 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {confirmingDistinctId === c.id ? 'Confirming…' : 'Confirm distinct'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {confirmDistinctError && <p className="mt-2 text-xs text-red-700">{confirmDistinctError}</p>}
        </div>
      )}

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Applicant Name</label>
              <input type="text" value={applicantName} onChange={(e) => setApplicantName(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Phone</label>
              <input type="text" value={applicantPhone} onChange={(e) => setApplicantPhone(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Project</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-1 input">
                <option value="">Select…</option>
                {projects?.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Source</label>
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="mt-1 input">
                <option value="">Select…</option>
                {sources?.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Temperature</label>
              <select value={temperatureId} onChange={(e) => setTemperatureId(e.target.value)} className="mt-1 input">
                <option value="">Select…</option>
                {temperatures?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          {applicantDefs.length > 0 && (
            <div data-testid="applicant-custom-fields">
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">Applicant</p>
              <CustomFieldInputs
                definitions={applicantDefs}
                values={applicantCf}
                onChange={(k, v) => setApplicantCf((p) => ({ ...p, [k]: v }))}
              />
            </div>
          )}
          {inquiryDefs.length > 0 && (
            <div data-testid="inquiry-custom-fields">
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">Inquiry</p>
              <CustomFieldInputs
                definitions={inquiryDefs}
                values={inquiryCf}
                onChange={(k, v) => setInquiryCf((p) => ({ ...p, [k]: v }))}
              />
            </div>
          )}

          <div className="mt-3 flex gap-3">
            <button onClick={handleCreate} className="btn btn-md btn-primary">Create</button>
            <button onClick={() => setShowForm(false)} className="btn btn-md btn-secondary">Cancel</button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      )}

      {listIsEmpty && isManagerTier && noReportsConfigured && (
        <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          Your team has no reports configured yet, so you only see your own leads.{' '}
          <Link to="/admin/users" className="font-medium underline">
            Go to Admin → Users
          </Link>{' '}
          and set this user as each report's manager.
        </div>
      )}

      <div className="mt-4">
        {isError ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            Couldn&apos;t load inquiries. Reload the page to try again.
          </p>
        ) : (
          <DataTable
            columns={columns}
            data={data?.data ?? []}
            isLoading={isLoading}
            emptyText={anyFilter ? 'No inquiries match these filters. Clear the filters to see all.' : 'No inquiries yet. Use "New inquiry" to add one.'}
          />
        )}
        {data?.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
      </div>
    </div>
  );
}
