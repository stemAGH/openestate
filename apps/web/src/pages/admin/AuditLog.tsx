import { useState } from 'react';
import { usePaginatedQuery } from '../../lib/hooks';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  user?: { name: string; email: string } | null;
}

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [entityFilter, setEntityFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params: Record<string, string | number> = { page, limit: 30 };
  if (entityFilter) params.entityType = entityFilter;

  const { data, isLoading } = usePaginatedQuery<AuditEntry>(
    ['audit'],
    '/audit',
    params,
  );

  const columns: Column<AuditEntry>[] = [
    {
      key: 'createdAt',
      header: 'Time',
      render: (e) => new Date(e.createdAt).toLocaleString('en-IN'),
    },
    {
      key: 'action',
      header: 'Action',
      render: (e) => (
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            e.action === 'CREATE'
              ? 'bg-emerald-50 text-emerald-700'
              : e.action === 'UPDATE'
                ? 'bg-blue-50 text-blue-700'
                : 'bg-red-50 text-red-700'
          }`}
        >
          {e.action}
        </span>
      ),
    },
    { key: 'entityType', header: 'Entity', render: (e) => e.entityType },
    {
      key: 'user',
      header: 'User',
      render: (e) => e.user?.name ?? e.userId ?? 'System',
    },
    {
      key: 'details',
      header: '',
      className: 'text-right',
      render: (e) =>
        (e.before || e.after) ? (
          <button
            onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
            className="text-blue-600 hover:text-blue-800 text-xs"
          >
            {expandedId === e.id ? 'Hide' : 'Details'}
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      <h1 className="page-title">Audit Log</h1>

      <div className="mt-4">
        <input
          type="text"
          placeholder="Filter by entity type…"
          value={entityFilter}
          onChange={(e) => {
            setEntityFilter(e.target.value);
            setPage(1);
          }}
          className="w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />

        {expandedId && data?.data && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-white p-4">
            {(() => {
              const entry = data.data.find((e) => e.id === expandedId);
              if (!entry) return null;
              return (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {entry.before && (
                    <div>
                      <h3 className="text-sm font-medium text-slate-700 mb-1">Before</h3>
                      <pre className="rounded bg-slate-50 p-3 text-xs overflow-x-auto">
                        {JSON.stringify(entry.before, null, 2)}
                      </pre>
                    </div>
                  )}
                  {entry.after && (
                    <div>
                      <h3 className="text-sm font-medium text-slate-700 mb-1">After</h3>
                      <pre className="rounded bg-slate-50 p-3 text-xs overflow-x-auto">
                        {JSON.stringify(entry.after, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {data?.meta && (
          <Pagination
            page={data.meta.page}
            totalPages={data.meta.totalPages}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
