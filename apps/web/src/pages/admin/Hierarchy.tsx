import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface HierarchyNode {
  id: string;
  name: string;
  email: string | null;
  roleName: string | null;
  roleSlug: string | null;
  directReportCount: number;
  reports: HierarchyNode[];
}

function Node({ node, depth }: { node: HierarchyNode; depth: number }) {
  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-200 bg-white px-3 py-2"
        style={{ marginLeft: depth * 20 }}
      >
        <span className="font-medium text-slate-900">{node.name}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
          {node.roleName ?? 'No role'}
        </span>
        <span className="text-xs text-slate-500">
          {node.directReportCount === 0
            ? 'No direct reports'
            : `${node.directReportCount} direct report${node.directReportCount === 1 ? '' : 's'}`}
        </span>
        {node.email && <span className="text-xs text-slate-400">{node.email}</span>}
      </div>
      {node.reports.length > 0 && (
        <ul className="mt-2 space-y-2">
          {node.reports.map((child) => (
            <Node key={child.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function HierarchyPage() {
  const { data, isLoading } = useQuery<HierarchyNode[]>({
    queryKey: ['user-hierarchy'],
    queryFn: () => api('/users/hierarchy'),
  });

  const total = (nodes: HierarchyNode[]): number =>
    nodes.reduce((sum, n) => sum + 1 + total(n.reports), 0);

  return (
    <div>
      <h1 className="page-title">Reporting hierarchy</h1>
      <p className="mt-1 text-sm text-slate-500">
        Read-only. Shows what you can see — your own reporting line, or the whole company if
        you're an admin. Change a person's manager from{' '}
        <span className="font-medium">Admin → Users</span>.
      </p>

      {isLoading && <p className="mt-6 text-sm text-slate-500">Loading…</p>}

      {data && data.length === 0 && (
        <p className="mt-6 text-sm text-slate-500">No active users are visible to you.</p>
      )}

      {data && data.length > 0 && (
        <>
          <p className="mt-6 text-xs uppercase tracking-wider text-slate-400">
            {total(data)} {total(data) === 1 ? 'person' : 'people'}
          </p>
          <ul className="mt-2 space-y-2">
            {data.map((node) => (
              <Node key={node.id} node={node} depth={0} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
