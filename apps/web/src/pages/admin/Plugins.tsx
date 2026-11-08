import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';

interface PluginSummary {
  pluginId: string;
  name: string;
  kind: string;
  version: string;
  description: string;
  status: 'active' | 'version-mismatch' | 'not-found';
  installed: boolean;
  isEnabled: boolean;
}

const STATUS_BADGE: Record<PluginSummary['status'], string> = {
  active: 'bg-emerald-100 text-emerald-800',
  'version-mismatch': 'bg-amber-100 text-amber-800',
  'not-found': 'bg-slate-200 text-slate-600',
};

export default function PluginsPage() {
  const qc = useQueryClient();
  const { data: plugins, isLoading } = useQuery<PluginSummary[]>({
    queryKey: ['plugins'],
    queryFn: () => api('/admin/plugins'),
  });

  const install = async (pluginId: string) => {
    await api(`/admin/plugins/${pluginId}/install`, { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['plugins'] });
  };

  const toggle = async (pluginId: string, isEnabled: boolean) => {
    await api(`/admin/plugins/${pluginId}/${isEnabled ? 'disable' : 'enable'}`, { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['plugins'] });
  };

  const uninstall = async (pluginId: string) => {
    if (!confirm(`Uninstall "${pluginId}"? Its stored config will be deleted.`)) return;
    await api(`/admin/plugins/${pluginId}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['plugins'] });
  };

  return (
    <div>
      <h1 className="page-title">Plugins</h1>
      <p className="mt-1 text-sm text-slate-500">
        First-party plugins ship as reviewed packages in this codebase — install and configure them per company here.
      </p>

      <div className="mt-4 space-y-3">
        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {!isLoading && (plugins ?? []).length === 0 && <p className="text-sm text-slate-500">No plugins available in this build.</p>}

        {(plugins ?? []).map((p) => (
          <div key={p.pluginId} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-medium text-slate-900">{p.name}</h2>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[p.status]}`}>{p.status}</span>
                  {p.installed && (
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${p.isEnabled ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600'}`}>
                      {p.isEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-500">{p.description}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {p.pluginId} · {p.kind} · v{p.version}
                </p>
              </div>

              <div className="flex shrink-0 gap-2">
                {p.installed ? (
                  <>
                    <Link
                      to={`/admin/plugins/${p.pluginId}`}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Configure
                    </Link>
                    {p.status === 'active' && (
                      <button
                        onClick={() => toggle(p.pluginId, p.isEnabled)}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {p.isEnabled ? 'Disable' : 'Enable'}
                      </button>
                    )}
                    <button onClick={() => uninstall(p.pluginId)} className="rounded-md px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50">
                      Uninstall
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => install(p.pluginId)}
                    disabled={p.status !== 'active'}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Install
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
