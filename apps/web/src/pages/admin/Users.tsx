import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePaginatedQuery, useApiMutation } from '../../lib/hooks';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';

interface User {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  totpEnabled: boolean;
  forcePasswordChange: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  role: { id: string; name: string; slug: string };
}

export default function UsersPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const { data, isLoading } = usePaginatedQuery<User>(
    ['users'],
    '/users',
    { page, limit: 20, search },
  );

  const deactivate = useApiMutation<unknown, { id: string }>(
    'POST',
    (body) => `/users/${body.id}/deactivate`,
    [['users']],
  );

  const reactivate = useApiMutation<unknown, { id: string }>(
    'POST',
    (body) => `/users/${body.id}/reactivate`,
    [['users']],
  );

  const columns: Column<User>[] = [
    { key: 'name', header: 'Name', render: (u) => u.name },
    { key: 'email', header: 'Email', render: (u) => u.email },
    {
      key: 'role',
      header: 'Role',
      render: (u) => (
        <span className="inline-block rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          {u.role.name}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (u) => (
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            u.isActive
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {u.isActive ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (u) => (
        <div className="flex justify-end gap-2">
          <Link
            to={`/admin/users/${u.id}`}
            className="text-blue-600 hover:text-blue-800 text-xs"
          >
            Edit
          </Link>
          {u.isActive ? (
            <button
              onClick={() => deactivate.mutate({ id: u.id })}
              className="text-red-600 hover:text-red-800 text-xs"
            >
              Deactivate
            </button>
          ) : (
            <button
              onClick={() => reactivate.mutate({ id: u.id })}
              className="text-emerald-600 hover:text-emerald-800 text-xs"
            >
              Reactivate
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Users</h1>
        <Link
          to="/admin/users/new"
          className="btn btn-md btn-primary"
        >
          Add User
        </Link>
      </div>

      <div className="mt-4">
        <input
          type="text"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="w-full max-w-sm rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />
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
