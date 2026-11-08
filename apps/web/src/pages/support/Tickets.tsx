import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  raisedByName: string | null;
  categoryName: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  slaByAt: string | null;
  createdAt: string;
}

const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

function isOverdue(t: Ticket): boolean {
  // slaByAt exists in the schema but nothing sets it yet — this renders
  // what's modelled, it doesn't invent an SLA policy. A resolved/closed
  // ticket is never "overdue" regardless of its deadline.
  return !!t.slaByAt && new Date(t.slaByAt) < new Date() && t.status !== 'RESOLVED' && t.status !== 'CLOSED';
}

export default function TicketsPage() {
  const [status, setStatus] = useState('');

  // GET /admin/tickets returns a plain array, not {data, meta} —
  // usePaginatedQuery would silently break here the same way it did for
  // Roles (CLAUDE.md's "issue #6").
  const { data: tickets, isLoading } = useQuery<Ticket[]>({
    queryKey: ['admin-tickets', status],
    queryFn: () => api(`/admin/tickets${status ? `?status=${status}` : ''}`),
  });

  const columns: Column<Ticket>[] = [
    {
      key: 'subject',
      header: 'Subject',
      render: (t) => (
        <Link to={`/support/tickets/${t.id}`} className="text-blue-600 hover:text-blue-800">
          {t.subject}
        </Link>
      ),
    },
    { key: 'raisedBy', header: 'Raised By', render: (t) => t.raisedByName ?? '—' },
    { key: 'category', header: 'Category', render: (t) => t.categoryName ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (t) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
            {t.status}
          </span>
          {isOverdue(t) && (
            <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              Overdue
            </span>
          )}
        </span>
      ),
    },
    { key: 'messages', header: 'Messages', render: (t) => t.messageCount },
    {
      key: 'lastActivity',
      header: 'Last Activity',
      render: (t) => new Date(t.lastMessageAt ?? t.createdAt).toLocaleString(),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Support Tickets</h1>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => setStatus('')}
          className={`rounded-md px-3 py-1.5 text-sm ${status === '' ? 'bg-blue-600 text-white' : 'border border-slate-300 text-slate-700 hover:bg-slate-50'}`}
        >
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-md px-3 py-1.5 text-sm ${status === s ? 'bg-blue-600 text-white' : 'border border-slate-300 text-slate-700 hover:bg-slate-50'}`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <DataTable columns={columns} data={tickets ?? []} isLoading={isLoading} emptyText="No tickets" />
      </div>
    </div>
  );
}
