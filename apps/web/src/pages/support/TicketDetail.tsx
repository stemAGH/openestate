import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface TicketMessage {
  id: string;
  authorIsStaff: boolean;
  body: string;
  createdAt: string;
}

interface Ticket {
  id: string;
  subject: string;
  status: string;
  raisedByName: string | null;
  categoryName: string | null;
  createdAt: string;
  messages: TicketMessage[];
}

const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState('');
  const [statusError, setStatusError] = useState('');

  const { data: ticket } = useQuery<Ticket>({
    queryKey: ['admin-ticket', id],
    queryFn: () => api(`/admin/tickets/${id}`),
    enabled: !!id,
  });

  const handleReply = async () => {
    setReplyError('');
    if (reply.trim() === '') return;
    try {
      await api(`/admin/tickets/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ body: reply.trim() }),
      });
      qc.invalidateQueries({ queryKey: ['admin-ticket', id] });
      qc.invalidateQueries({ queryKey: ['admin-tickets'] });
      setReply('');
    } catch (err) {
      setReplyError((err as Error).message);
    }
  };

  const handleStatusChange = async (status: string) => {
    setStatusError('');
    try {
      await api(`/admin/tickets/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      qc.invalidateQueries({ queryKey: ['admin-ticket', id] });
      qc.invalidateQueries({ queryKey: ['admin-tickets'] });
    } catch (err) {
      setStatusError((err as Error).message);
    }
  };

  if (!ticket) return <div className="text-slate-500">Loading…</div>;

  return (
    <div>
      <h1 className="page-title">{ticket.subject}</h1>
      <p className="text-sm text-slate-500">
        {ticket.raisedByName ?? 'Unknown'} {ticket.categoryName && <>· {ticket.categoryName}</>} · Raised{' '}
        {new Date(ticket.createdAt).toLocaleString()}
      </p>

      <section className="mt-4">
        <h2 className="section-title">Status: {ticket.status}</h2>
        <div className="mt-2 flex gap-2">
          {STATUSES.filter((s) => s !== ticket.status).map((s) => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              Mark {s}
            </button>
          ))}
        </div>
        {statusError && <p className="mt-2 text-sm text-red-600">{statusError}</p>}
      </section>

      <section className="mt-6">
        <h2 className="section-title">Thread</h2>
        <ul className="mt-3 space-y-3">
          {ticket.messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-md border p-3 text-sm ${
                m.authorIsStaff ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="font-medium text-slate-800">
                {m.authorIsStaff ? 'Staff' : ticket.raisedByName ?? 'Customer'} — {new Date(m.createdAt).toLocaleString()}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-slate-700">{m.body}</div>
            </li>
          ))}
        </ul>

        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <label className="block text-sm font-medium text-slate-700">Reply</label>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={3}
            className="mt-1 input"
          />
          <div className="mt-2">
            <button
              onClick={handleReply}
              disabled={reply.trim() === ''}
              className="btn btn-md btn-primary"
            >
              Send Reply
            </button>
          </div>
          {replyError && <p className="mt-2 text-sm text-red-600">{replyError}</p>}
        </div>
      </section>
    </div>
  );
}
