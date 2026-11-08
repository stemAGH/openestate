import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { usePaginatedQuery } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { api, downloadFile } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import CustomFieldInputs, {
  useCustomFieldDefinitions,
  buildCustomFieldPayload,
} from '../../components/CustomFieldInputs';

interface Inquiry {
  id: string;
  status: string;
  applicant: { id: string; name: string; primaryPhone: string };
  project: { id: string; name: string } | null;
  temperature: { id: string; name: string } | null;
  createdAt: string;
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
  const [page, setPage] = useState(1);
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
  const { data, isLoading } = usePaginatedQuery<Inquiry>(['inquiries'], '/inquiries', { page, limit: 20 });

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
    enabled: listIsEmpty && isManagerTier,
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
    { key: 'applicant', header: 'Applicant', render: (i) => <Link to={`/presales/inquiries/${i.id}`} className="text-blue-600 hover:underline">{i.applicant.name}</Link> },
    { key: 'phone', header: 'Phone', render: (i) => i.applicant.primaryPhone },
    { key: 'project', header: 'Project', render: (i) => i.project?.name ?? '—' },
    { key: 'temperature', header: 'Temperature', render: (i) => i.temperature?.name ?? '—' },
    { key: 'status', header: 'Status', render: (i) => i.status },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Inquiries</h1>
        <div className="flex gap-2">
          <button
            onClick={() => downloadFile('/reports/presales/inquiries-export?format=csv', 'inquiries-export.csv')}
            className="btn btn-sm btn-secondary"
          >
            Export CSV
          </button>
          <button
            onClick={() => setShowImport((v) => !v)}
            className="btn btn-sm btn-secondary"
          >
            Bulk Import
          </button>
          <button onClick={() => setShowForm(true)} className="btn btn-md btn-primary">
            Add Inquiry
          </button>
        </div>
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
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />
        {data?.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
      </div>
    </div>
  );
}
