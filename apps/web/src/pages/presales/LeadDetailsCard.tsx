import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatInr } from '@openestate/shared';
import { api } from '../../lib/api';
import { Card } from '../../ui';
import CustomFieldInputs, { buildCustomFieldPayload, useCustomFieldDefinitions } from '../../components/CustomFieldInputs';

export interface LeadDetails {
  id: string;
  projectId: string | null;
  sourceId: string | null;
  inquiryTypeId: string | null;
  temperatureId: string | null;
  preferredUnitTypeId: string | null;
  budgetMinPaise: string | null;
  budgetMaxPaise: string | null;
  customFields?: Record<string, unknown> | null;
  project: { id: string; name: string } | null;
  source?: { id: string; name: string } | null;
  inquiryType?: { id: string; name: string } | null;
  temperature?: { id: string; name: string } | null;
  preferredUnitType?: { id: string; name: string } | null;
}

interface Option {
  id: string;
  name: string;
}

const toRupees = (paise: string | null) => (paise == null ? '' : String(Number(BigInt(paise)) / 100));
const toPaise = (rupees: string) => String(Math.round(Number(rupees) * 100));

/**
 * The lead's details (project, source, type, temperature, preferred unit type,
 * budget, custom fields), read-only until "Edit details"; saving sends only
 * the fields that changed. For presales.inquiry.update holders.
 */
export default function LeadDetailsCard({ inquiry, canEdit, onSaved }: { inquiry: LeadDetails; canEdit: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [cf, setCf] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { definitions } = useCustomFieldDefinitions('INQUIRY');

  // Loaded only while editing.
  const opts = (key: string, path: string) => ({ queryKey: ['lead-edit', key], queryFn: () => api<{ data: Option[] }>(path), enabled: editing });
  const projects = useQuery(opts('projects', '/projects?limit=100'));
  const sources = useQuery(opts('sources', '/masters/inquiry-sources?limit=100'));
  const types = useQuery(opts('types', '/masters/inquiry-types?limit=100'));
  const temperatures = useQuery(opts('temperatures', '/masters/inquiry-temperatures?limit=100'));
  const unitTypes = useQuery(opts('unit-types', '/masters/unit-types?limit=100'));

  function start() {
    setForm({
      projectId: inquiry.projectId ?? '',
      sourceId: inquiry.sourceId ?? '',
      inquiryTypeId: inquiry.inquiryTypeId ?? '',
      temperatureId: inquiry.temperatureId ?? '',
      preferredUnitTypeId: inquiry.preferredUnitTypeId ?? '',
      budgetMin: toRupees(inquiry.budgetMinPaise),
      budgetMax: toRupees(inquiry.budgetMaxPaise),
    });
    setCf({ ...(inquiry.customFields ?? {}) });
    setError('');
    setEditing(true);
  }

  const budgetError =
    form.budgetMin && form.budgetMax && Number(form.budgetMax) < Number(form.budgetMin) ? 'Budget max is below budget min.' : '';

  async function save() {
    setError('');
    const body: Record<string, unknown> = {};
    for (const k of ['projectId', 'sourceId', 'inquiryTypeId', 'temperatureId', 'preferredUnitTypeId'] as const) {
      if (form[k] && form[k] !== (inquiry[k] ?? '')) body[k] = form[k];
    }
    if (form.budgetMin && form.budgetMin !== toRupees(inquiry.budgetMinPaise)) body.budgetMinPaise = toPaise(form.budgetMin);
    if (form.budgetMax && form.budgetMax !== toRupees(inquiry.budgetMaxPaise)) body.budgetMaxPaise = toPaise(form.budgetMax);
    const custom = buildCustomFieldPayload(definitions, cf);
    if (definitions.length && custom) body.customFields = custom;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await api(`/inquiries/${inquiry.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const select = (id: string, label: string, key: string, options?: Option[]) => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">{label}</label>
      <select id={id} value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="mt-1 input">
        <option value="">—</option>
        {options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  const budget =
    inquiry.budgetMinPaise || inquiry.budgetMaxPaise
      ? `${inquiry.budgetMinPaise ? formatInr(BigInt(inquiry.budgetMinPaise)) : '—'} to ${inquiry.budgetMaxPaise ? formatInr(BigInt(inquiry.budgetMaxPaise)) : '—'}`
      : '—';

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">Details</h2>
        {canEdit && !editing && (
          <button onClick={start} className="btn btn-sm btn-secondary">Edit details</button>
        )}
      </div>
      {!editing ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-fg-2">Project</dt><dd>{inquiry.project?.name ?? '—'}</dd></div>
          <div><dt className="text-fg-2">Source</dt><dd>{inquiry.source?.name ?? '—'}</dd></div>
          <div><dt className="text-fg-2">Inquiry type</dt><dd>{inquiry.inquiryType?.name ?? '—'}</dd></div>
          <div><dt className="text-fg-2">Temperature</dt><dd>{inquiry.temperature?.name ?? '—'}</dd></div>
          <div><dt className="text-fg-2">Preferred unit type</dt><dd>{inquiry.preferredUnitType?.name ?? '—'}</dd></div>
          <div><dt className="text-fg-2">Budget</dt><dd data-testid="lead-budget">{budget}</dd></div>
        </dl>
      ) : (
        <div className="mt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {select('ld-project', 'Project', 'projectId', projects.data?.data)}
            {select('ld-source', 'Source', 'sourceId', sources.data?.data)}
            {select('ld-type', 'Inquiry type', 'inquiryTypeId', types.data?.data)}
            {select('ld-temperature', 'Temperature', 'temperatureId', temperatures.data?.data)}
            {select('ld-unit-type', 'Preferred unit type', 'preferredUnitTypeId', unitTypes.data?.data)}
            <div />
            <div>
              <label htmlFor="ld-budget-min" className="block text-sm font-medium text-slate-700">Budget min (₹)</label>
              <input id="ld-budget-min" type="number" min={0} value={form.budgetMin ?? ''} onChange={(e) => setForm({ ...form, budgetMin: e.target.value })} className="mt-1 input" />
            </div>
            <div>
              <label htmlFor="ld-budget-max" className="block text-sm font-medium text-slate-700">Budget max (₹)</label>
              <input id="ld-budget-max" type="number" min={0} value={form.budgetMax ?? ''} onChange={(e) => setForm({ ...form, budgetMax: e.target.value })} className="mt-1 input" />
            </div>
          </div>
          {budgetError && <p className="mt-2 text-sm text-red-600">{budgetError}</p>}
          <CustomFieldInputs definitions={definitions} values={cf} onChange={(k, v) => setCf({ ...cf, [k]: v })} />
          <div className="mt-3 flex flex-wrap gap-3">
            <button onClick={save} disabled={saving || !!budgetError} className="btn btn-md btn-primary">
              {saving ? 'Saving…' : 'Save details'}
            </button>
            <button onClick={() => setEditing(false)} className="btn btn-md btn-secondary">Cancel</button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      )}
    </Card>
  );
}
