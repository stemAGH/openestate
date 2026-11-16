import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { formatDate, LEAD_DELETE_REASON_LABELS, type LeadDeleteReason } from '@openestate/shared';
import { usePaginatedQuery } from '../../lib/hooks';
import { api } from '../../lib/api';
import Pagination from '../../components/Pagination';
import { Card, EmptyState, PageHeader } from '../../ui';

interface DeletedLead {
  id: string;
  deletedAt: string;
  purgeAfter: string;
  deleteReason: LeadDeleteReason | null;
  deleteNote: string | null;
  applicant: { id: string; name: string; primaryPhone: string };
  project: { id: string; name: string } | null;
  deletedBy: { id: string; name: string } | null;
}

/** Deleted leads in the user's team scope (needs presales.lead.delete): restore one before it is purged. */
export default function DeletedLeadsPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  const { data, isLoading, isError } = usePaginatedQuery<DeletedLead>(['inquiries', 'deleted'], '/inquiries/deleted', { page, limit: 20 });

  async function restore(lead: DeletedLead) {
    setMessage('');
    try {
      await api(`/inquiries/${lead.id}/restore`, { method: 'POST' });
      setMessage(`${lead.applicant.name}'s lead is restored.`);
      qc.invalidateQueries({ queryKey: ['inquiries'] });
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Deleted leads"
        description="Restore a lead before its purge date; after that it is removed for good. The person's contact record is never deleted."
        actions={<Link to="/presales/inquiries" className="btn btn-sm btn-secondary">Back to Inquiries</Link>}
      />
      {message && (
        <div role="status" className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {message}
        </div>
      )}
      <Card className="mt-4 overflow-x-auto">
        {isLoading ? (
          <p className="p-4 text-sm text-slate-600">Loading…</p>
        ) : isError ? (
          <p className="p-4 text-sm text-red-700">Deleted leads couldn&apos;t be loaded.</p>
        ) : !data?.data.length ? (
          <EmptyState message="No deleted leads." />
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-slate-600">
                <th className="px-4 py-2">Lead</th>
                <th className="px-4 py-2">Project</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2">Deleted</th>
                <th className="px-4 py-2">Purged after</th>
                <th className="px-4 py-2"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((l) => (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-900">{l.applicant.name}</div>
                    <div className="text-xs text-slate-600">{l.applicant.primaryPhone}</div>
                  </td>
                  <td className="px-4 py-2">{l.project?.name ?? '—'}</td>
                  <td className="px-4 py-2">
                    {l.deleteReason ? LEAD_DELETE_REASON_LABELS[l.deleteReason] : '—'}
                    {l.deleteNote && <div className="text-xs text-slate-600">{l.deleteNote}</div>}
                  </td>
                  <td className="px-4 py-2">
                    {formatDate(l.deletedAt)}
                    {l.deletedBy && <div className="text-xs text-slate-600">by {l.deletedBy.name}</div>}
                  </td>
                  <td className="px-4 py-2">{formatDate(l.purgeAfter)}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => restore(l)} className="btn btn-sm btn-secondary">
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {data && data.meta.totalPages > 1 && <Pagination page={page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
    </div>
  );
}
