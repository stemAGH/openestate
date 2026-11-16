import { formatDateTime } from '@openestate/shared';
import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface TicketMessage {
  id: string;
  authorIsStaff: boolean;
  body: string;
  createdAt: string;
}

interface TicketThread {
  id: string;
  subject: string;
  status: string;
  messages: TicketMessage[];
}

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [reply, setReply] = useState('');

  const { data, isLoading } = useQuery<TicketThread>({
    queryKey: ['portal', 'tickets', id],
    queryFn: () => api(`/portal/tickets/${id}`),
    enabled: !!id,
  });

  const mutation = useMutation({
    mutationFn: () => api(`/portal/tickets/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: reply }) }),
    onSuccess: () => {
      setReply('');
      qc.invalidateQueries({ queryKey: ['portal', 'tickets', id] });
    },
  });

  if (isLoading) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (!data) return <div className="text-slate-500 text-sm">Ticket not found.</div>;

  return (
    <div className="space-y-4">
      <Link to="/tickets" className="text-sm text-blue-600">
        ← Back to Support
      </Link>

      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-900 truncate min-w-0">{data.subject}</h1>
        <span className="text-xs rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 shrink-0">{data.status}</span>
      </div>

      <div className="space-y-2">
        {data.messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-lg p-3 text-sm max-w-[85%] ${
              m.authorIsStaff ? 'bg-white border border-slate-200' : 'bg-blue-50 border border-blue-100 ml-auto'
            }`}
          >
            <p className="text-slate-800 whitespace-pre-wrap">{m.body}</p>
            <p className="text-xs text-slate-400 mt-1">
              {m.authorIsStaff ? 'Support team' : 'You'} · {formatDateTime(m.createdAt)}
            </p>
          </div>
        ))}
      </div>

      {data.status !== 'CLOSED' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) mutation.mutate();
          }}
          className="flex gap-2"
        >
          <input
            placeholder="Type a reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={mutation.isPending || !reply.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}
