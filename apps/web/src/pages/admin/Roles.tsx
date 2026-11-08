import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApiMutation } from '../../lib/hooks';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';

interface Role {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  _count?: { users: number };
  permissions?: Array<{ permission: { key: string } }>;
}

export default function RolesPage() {
  // GET /roles returns every role for the company as a plain array (not
  // paginated — roles.controller.ts's findAll ignores query params
  // entirely), so this can't use usePaginatedQuery/{data, meta} like the
  // other admin list pages.
  const { data, isLoading } = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: () => api('/roles'),
  });

  const deleteMutation = useApiMutation<unknown, { id: string }>(
    'DELETE',
    (body) => `/roles/${body.id}`,
    [['roles']],
  );

  const columns: Column<Role>[] = [
    { key: 'name', header: 'Name', render: (r) => r.name },
    { key: 'slug', header: 'Slug', render: (r) => r.slug },
    {
      key: 'system',
      header: 'Type',
      render: (r) => (
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            r.isSystem
              ? 'bg-purple-50 text-purple-700'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {r.isSystem ? 'System' : 'Custom'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Link
            to={`/admin/roles/${r.id}`}
            className="text-blue-600 hover:text-blue-800 text-xs"
          >
            Edit
          </Link>
          {!r.isSystem && (
            <button
              onClick={() => {
                if (confirm(`Delete role "${r.name}"?`)) {
                  deleteMutation.mutate({ id: r.id });
                }
              }}
              className="text-red-600 hover:text-red-800 text-xs"
            >
              Delete
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Roles</h1>
        <Link
          to="/admin/roles/new"
          className="btn btn-md btn-primary"
        >
          Add Role
        </Link>
      </div>

      <div className="mt-4">
        <DataTable columns={columns} data={data ?? []} isLoading={isLoading} />
      </div>
    </div>
  );
}
