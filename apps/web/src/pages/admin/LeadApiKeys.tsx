import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';

interface LeadApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  fieldMapping: Record<string, string>;
  rateLimitPerMinute: number;
  isActive: boolean;
  lastUsedAt: string | null;
}

const MAPPING_FIELDS = [
  { key: 'name', label: 'Name (required)' },
  { key: 'phone', label: 'Phone (required)' },
  { key: 'email', label: 'Email' },
  { key: 'projectId', label: 'Project ID' },
  { key: 'note', label: 'Note' },
];

export default function LeadApiKeysPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({ name: 'lead.name', phone: 'lead.phone' });
  const [rateLimitPerMinute, setRateLimitPerMinute] = useState('60');
  const [formError, setFormError] = useState('');
  const [revealedKey, setRevealedKey] = useState<{ name: string; rawKey: string } | null>(null);

  const { data: keys, isLoading } = useQuery<LeadApiKey[]>({
    queryKey: ['lead-api-keys'],
    queryFn: () => api('/admin/lead-api-keys'),
  });

  const handleCreate = async () => {
    setFormError('');
    try {
      const fieldMapping = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v.trim() !== ''));
      const result = await api<{ name: string; rawKey: string }>('/admin/lead-api-keys', {
        method: 'POST',
        body: JSON.stringify({ name, fieldMapping, rateLimitPerMinute: Number(rateLimitPerMinute) }),
      });
      qc.invalidateQueries({ queryKey: ['lead-api-keys'] });
      setShowForm(false);
      setRevealedKey({ name: result.name, rawKey: result.rawKey });
      setName('');
      setMapping({ name: 'lead.name', phone: 'lead.phone' });
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const disable = async (id: string) => {
    await api(`/admin/lead-api-keys/${id}/disable`, { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['lead-api-keys'] });
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this API key? Any integration using it will stop working immediately.')) return;
    await api(`/admin/lead-api-keys/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['lead-api-keys'] });
  };

  const columns: Column<LeadApiKey>[] = [
    { key: 'name', header: 'Name', render: (k) => k.name },
    { key: 'prefix', header: 'Key', render: (k) => <span className="font-mono text-xs">{k.keyPrefix}…</span> },
    { key: 'mapping', header: 'Field Mapping', render: (k) => <span className="font-mono text-xs">{JSON.stringify(k.fieldMapping)}</span> },
    { key: 'rateLimit', header: 'Rate Limit', render: (k) => `${k.rateLimitPerMinute}/min` },
    {
      key: 'status',
      header: 'Status',
      render: (k) => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${k.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}`}>
          {k.isActive ? 'Active' : 'Disabled'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (k) => (
        <div className="flex justify-end gap-2">
          {k.isActive && (
            <button onClick={() => disable(k.id)} className="text-slate-600 hover:text-slate-800 text-xs">
              Disable
            </button>
          )}
          <button onClick={() => remove(k.id)} className="text-red-600 hover:text-red-800 text-xs">
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Lead API Keys</h1>
        <button
          onClick={() => setShowForm(true)}
          className="btn btn-md btn-primary"
        >
          Create Key
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        POST <code className="font-mono">/api/v1/leads/inbound</code> with header <code className="font-mono">X-Api-Key</code> — the field mapping
        below tells OpenEstate where to find each value in the vendor's JSON payload (dot-path, e.g. <code className="font-mono">lead.mobile</code>).
      </p>

      {revealedKey && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Key created for &ldquo;{revealedKey.name}&rdquo; — copy it now, it will never be shown again:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 select-all rounded bg-white border border-amber-300 px-3 py-2 text-sm font-mono">{revealedKey.rawKey}</code>
            <button
              onClick={() => navigator.clipboard.writeText(revealedKey.rawKey)}
              className="rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
            >
              Copy
            </button>
          </div>
          <button onClick={() => setRevealedKey(null)} className="mt-2 text-xs text-amber-700 hover:underline">
            Dismiss
          </button>
        </div>
      )}

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="99acres integration"
              className="mt-1 block w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Field Mapping</label>
            <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {MAPPING_FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="block text-xs text-slate-500">{f.label}</label>
                  <input
                    type="text"
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => setMapping((p) => ({ ...p, [f.key]: e.target.value }))}
                    placeholder="lead.field_path"
                    className="mt-0.5 block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="max-w-xs">
            <label className="block text-sm font-medium text-slate-700">Rate Limit (per minute)</label>
            <input
              type="number"
              min={1}
              value={rateLimitPerMinute}
              onChange={(e) => setRateLimitPerMinute(e.target.value)}
              className="mt-1 input"
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              className="btn btn-md btn-primary"
            >
              Create
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="btn btn-md btn-secondary"
            >
              Cancel
            </button>
          </div>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={keys ?? []} isLoading={isLoading} />
      </div>
    </div>
  );
}
