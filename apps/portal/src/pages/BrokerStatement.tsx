import { formatDate } from '@openestate/shared';
import { useQuery } from '@tanstack/react-query';
import { api, downloadFile } from '../lib/api';

interface GeneratedDocument {
  id: string;
  documentType: string;
  originalName: string;
  createdAt: string;
}

export default function BrokerStatement() {
  const { data, isLoading } = useQuery<GeneratedDocument[]>({
    queryKey: ['portal', 'broker', 'documents'],
    queryFn: () => api('/portal/broker/documents'),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Commission Statements</h1>

      {isLoading && <div className="text-slate-600 text-sm">Loading…</div>}
      {data && data.length === 0 && (
        <div className="text-slate-600 text-sm">No statements have been generated yet.</div>
      )}

      {data && data.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <ul className="divide-y divide-slate-100">
            {data.map((d) => (
              <li key={d.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-700">
                  {formatDate(d.createdAt)}
                </span>
                <button
                  onClick={() => void downloadFile(`/portal/broker/documents/${d.id}/download`, d.originalName)}
                  className="text-blue-600 text-sm font-medium"
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
