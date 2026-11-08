import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface PluginConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select';
  required: boolean;
  secret?: boolean;
  options?: string[];
  helpText?: string;
}

interface PluginDetail {
  pluginId: string;
  name: string;
  kind: string;
  version: string;
  description: string;
  configFields: PluginConfigField[];
  status: 'active' | 'version-mismatch' | 'not-found';
  versionMismatch: { requiredRange: string; runningCoreVersion: string } | null;
  installed: boolean;
  isEnabled: boolean;
  config: Record<string, unknown> | null;
}

export default function PluginDetailPage() {
  const { pluginId } = useParams<{ pluginId: string }>();
  const qc = useQueryClient();
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState(false);

  const { data: plugin, isLoading } = useQuery<PluginDetail>({
    queryKey: ['plugin', pluginId],
    queryFn: () => api(`/admin/plugins/${pluginId}`),
  });

  useEffect(() => {
    if (!plugin) return;
    const initial: Record<string, string | boolean> = {};
    for (const field of plugin.configFields) {
      if (field.secret) {
        initial[field.key] = '';
      } else {
        const v = plugin.config?.[field.key];
        initial[field.key] = field.type === 'boolean' ? Boolean(v) : v != null ? String(v) : '';
      }
    }
    setFormValues(initial);
  }, [plugin]);

  const saveConfig = async () => {
    setFormError('');
    setSaved(false);
    try {
      const body: Record<string, unknown> = {};
      for (const field of plugin!.configFields) {
        const raw = formValues[field.key];
        if (field.type === 'number') body[field.key] = raw === '' ? undefined : Number(raw);
        else if (field.type === 'boolean') body[field.key] = Boolean(raw);
        else body[field.key] = raw;
      }
      await api(`/admin/plugins/${pluginId}/config`, { method: 'PUT', body: JSON.stringify(body) });
      qc.invalidateQueries({ queryKey: ['plugin', pluginId] });
      setSaved(true);
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const toggle = async () => {
    await api(`/admin/plugins/${pluginId}/${plugin!.isEnabled ? 'disable' : 'enable'}`, { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['plugin', pluginId] });
  };

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!plugin) return <p className="text-sm text-red-600">Plugin not found.</p>;

  return (
    <div>
      <Link to="/admin/plugins" className="text-sm text-blue-600 hover:underline">
        ← Back to Plugins
      </Link>

      <div className="mt-2 flex items-center justify-between">
        <h1 className="page-title">{plugin.name}</h1>
        {plugin.installed && plugin.status === 'active' && (
          <button
            onClick={toggle}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {plugin.isEnabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">{plugin.description}</p>

      {plugin.status === 'version-mismatch' && plugin.versionMismatch && (
        <p className="mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          Requires core API {plugin.versionMismatch.requiredRange}, but this install runs {plugin.versionMismatch.runningCoreVersion}.
        </p>
      )}

      {plugin.configFields.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">This plugin has no configurable fields.</p>
      ) : (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-800">Configuration</h2>
          {plugin.configFields.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-slate-700">
                {field.label}
                {field.required && <span className="text-red-500"> *</span>}
                {field.secret && <span className="ml-1 text-xs text-slate-400">(secret — re-enter to change)</span>}
              </label>
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={Boolean(formValues[field.key])}
                  onChange={(e) => setFormValues((p) => ({ ...p, [field.key]: e.target.checked }))}
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
              ) : field.type === 'select' ? (
                <select
                  value={String(formValues[field.key] ?? '')}
                  onChange={(e) => setFormValues((p) => ({ ...p, [field.key]: e.target.value }))}
                  className="mt-1 block w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {(field.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                  value={String(formValues[field.key] ?? '')}
                  onChange={(e) => setFormValues((p) => ({ ...p, [field.key]: e.target.value }))}
                  placeholder={field.secret ? '••••••••' : undefined}
                  className="mt-1 block w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              )}
              {field.helpText && <p className="mt-1 text-xs text-slate-400">{field.helpText}</p>}
            </div>
          ))}

          <div className="flex items-center gap-3">
            <button
              onClick={saveConfig}
              className="btn btn-md btn-primary"
            >
              Save Configuration
            </button>
            {saved && <span className="text-sm text-emerald-600">Saved.</span>}
          </div>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
        </div>
      )}
    </div>
  );
}
