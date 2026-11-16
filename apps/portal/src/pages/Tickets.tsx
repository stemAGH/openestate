import { formatDate } from '@openestate/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
}

interface TicketCategory {
  id: string;
  name: string;
}

export default function Tickets() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const { data, isLoading } = useQuery<Ticket[]>({
    queryKey: ['portal', 'tickets'],
    queryFn: () => api('/portal/tickets'),
  });
  const { data: categories } = useQuery<TicketCategory[]>({
    queryKey: ['portal', 'tickets', 'categories'],
    queryFn: () => api('/portal/tickets/categories'),
  });

  const mutation = useMutation({
    mutationFn: () =>
      api('/portal/tickets', { method: 'POST', body: JSON.stringify({ categoryId, subject, body }) }),
    onSuccess: () => {
      setShowForm(false);
      setSubject('');
      setBody('');
      setCategoryId('');
      qc.invalidateQueries({ queryKey: ['portal', 'tickets'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Support</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
        >
          {showForm ? 'Cancel' : 'Raise query'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="rounded-lg border border-slate-200 bg-white p-4 space-y-3"
        >
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
          >
            <option value="">Select a category…</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <textarea
            placeholder="How can we help?"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={mutation.isPending || !subject.trim() || !body.trim() || !categoryId.trim()}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Submit
          </button>
        </form>
      )}

      {isLoading && <div className="text-slate-600 text-sm">Loading…</div>}
      {data && data.length === 0 && !showForm && (
        <div className="text-slate-600 text-sm">No queries raised yet.</div>
      )}

      <div className="space-y-2">
        {data?.map((t) => (
          <Link
            key={t.id}
            to={`/tickets/${t.id}`}
            className="block rounded-lg border border-slate-200 bg-white p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-900 truncate min-w-0">{t.subject}</span>
              <span className="text-xs rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 shrink-0">{t.status}</span>
            </div>
            <span className="text-xs text-slate-400">{formatDate(t.createdAt)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
