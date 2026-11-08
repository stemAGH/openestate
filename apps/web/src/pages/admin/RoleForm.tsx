import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ALL_PERMISSIONS, PERMISSION_MODULES } from '@openestate/shared';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/hooks';

interface RoleDetail {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  isPortal: boolean;
  permissions: Array<{ permission: { id: string; key: string } }>;
}

interface PermissionItem {
  id: string;
  key: string;
}

export default function RoleForm() {
  const { id } = useParams<{ id: string }>();
  const isEdit = id && id !== 'new';
  const navigate = useNavigate();
  const [error, setError] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [slug, setSlug] = useState<string>('');
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());

  const { data: allPerms } = useQuery<PermissionItem[]>({
    queryKey: ['permissions-all'],
    queryFn: () => api('/roles/permissions'),
  });

  const { data: role } = useQuery<RoleDetail>({
    queryKey: ['role', id],
    queryFn: () => api(`/roles/${id}`),
    enabled: !!isEdit,
  });

  // A portal role (Customer, Broker) can only hold portal.* permissions;
  // the API refuses anything else, so only those are offered.
  const perms = role?.isPortal ? allPerms?.filter((p) => p.key.startsWith('portal.')) : allPerms;

  useEffect(() => {
    if (role) {
      setName(role.name);
      setSlug(role.slug);
      setSelectedPerms(new Set(role.permissions.map((p) => p.permission.id)));
    }
  }, [role]);

  const createMutation = useApiMutation<unknown, { name: string; slug: string; permissionIds: string[] }>(
    'POST',
    '/roles',
    [['roles']],
  );

  const updateMutation = useApiMutation<unknown, { name: string; permissionIds: string[] }>(
    'PATCH',
    `/roles/${id}`,
    [['roles'], ['role', id!]],
  );

  const togglePerm = (permId: string) => {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(permId)) next.delete(permId);
      else next.add(permId);
      return next;
    });
  };

  const toggleModule = (module: string) => {
    if (!perms) return;
    const modulePerms = perms.filter((p) => p.key.startsWith(module + '.'));
    const allSelected = modulePerms.every((p) => selectedPerms.has(p.id));
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      modulePerms.forEach((p) => {
        if (allSelected) next.delete(p.id);
        else next.add(p.id);
      });
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const permissionIds = Array.from(selectedPerms);
      if (isEdit) {
        await updateMutation.mutateAsync({ name, permissionIds });
      } else {
        await createMutation.mutateAsync({ name, slug, permissionIds });
      }
      navigate('/admin/roles');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="page-title">
        {isEdit ? 'Edit Role' : 'Add Role'}
      </h1>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={!!role?.isSystem}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
          />
          {role?.isSystem && (
            <p className="mt-1 text-xs text-slate-500">
              System role name cannot be changed, but its permissions can.
            </p>
          )}
        </div>

        {!isEdit && (
          <div>
            <label className="block text-sm font-medium text-slate-700">Slug</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
              pattern="^[a-z][a-z0-9_-]*$"
              className="mt-1 input"
            />
            <p className="mt-1 text-xs text-slate-500">Lowercase letters, numbers, hyphens, underscores</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Permissions</label>
          {role?.isPortal && (
            <p className="mb-2 text-xs text-slate-500">
              This is a portal role, so it can only hold portal permissions.
            </p>
          )}
          <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 max-h-96 overflow-y-auto">
            {PERMISSION_MODULES.map((module) => {
              const modulePerms = (perms ?? []).filter((p) =>
                p.key.startsWith(module + '.'),
              );
              if (modulePerms.length === 0) return null;

              const allChecked = modulePerms.every((p) => selectedPerms.has(p.id));
              const someChecked = modulePerms.some((p) => selectedPerms.has(p.id));

              return (
                <div key={module}>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = someChecked && !allChecked;
                      }}
                      onChange={() => toggleModule(module)}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                    <span className="text-sm font-medium text-slate-900 uppercase">
                      {module}
                    </span>
                  </label>
                  <div className="ml-6 mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {modulePerms.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedPerms.has(p.id)}
                          onChange={() => togglePerm(p.id)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                        />
                        <span className="text-xs text-slate-600">
                          {p.key.replace(module + '.', '')}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {selectedPerms.size} of {perms?.length ?? ALL_PERMISSIONS.length} permissions selected
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            className="btn btn-md btn-primary"
          >
            {isEdit ? 'Update Role' : 'Create Role'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/admin/roles')}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
