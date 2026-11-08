import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePaginatedQuery, useApiMutation } from '../../lib/hooks';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';

interface BrokerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  reraAgentNo: string | null;
  isActive: boolean;
}

export default function BrokersPage() {
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [reraAgentNo, setReraAgentNo] = useState('');
  const [pan, setPan] = useState('');
  const [error, setError] = useState('');

  const { data, isLoading } = usePaginatedQuery<BrokerRow>(['brokers'], '/brokers', { page, limit: 25 });

  const createMutation = useApiMutation<BrokerRow, Record<string, string>>('POST', '/brokers', [['brokers']]);
  const deactivateMutation = useApiMutation<unknown, { id: string }>(
    'POST',
    (body) => `/brokers/${body.id}/deactivate`,
    [['brokers']],
  );
  const reactivateMutation = useApiMutation<unknown, { id: string }>(
    'POST',
    (body) => `/brokers/${body.id}/reactivate`,
    [['brokers']],
  );

  function resetForm() {
    setName('');
    setPhone('');
    setEmail('');
    setReraAgentNo('');
    setPan('');
  }

  async function handleCreate() {
    setError('');
    try {
      const body: Record<string, string> = { name, phone };
      if (email) body.email = email;
      if (reraAgentNo) body.reraAgentNo = reraAgentNo;
      if (pan) body.pan = pan.toUpperCase();
      await createMutation.mutateAsync(body);
      setShowForm(false);
      resetForm();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const columns: Column<BrokerRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (b) => (
        <Link to={`/postsales/brokers/${b.id}`} className="font-medium text-blue-600 hover:text-blue-800">
          {b.name}
        </Link>
      ),
    },
    { key: 'phone', header: 'Phone', render: (b) => b.phone },
    { key: 'email', header: 'Email', render: (b) => b.email ?? '—' },
    { key: 'rera', header: 'RERA Agent No.', render: (b) => b.reraAgentNo ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (b) => (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            b.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {b.isActive ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (b) => (
        <div className="flex justify-end gap-2">
          <Link to={`/postsales/brokers/${b.id}`} className="text-xs text-blue-600 hover:text-blue-800">
            Manage
          </Link>
          {b.isActive ? (
            <button
              onClick={() => confirm('Deactivate this broker? Future cancellations for their bookings auto-approve NOC.') && deactivateMutation.mutate({ id: b.id })}
              className="text-xs text-red-600 hover:text-red-800"
            >
              Deactivate
            </button>
          ) : (
            <button
              onClick={() => reactivateMutation.mutate({ id: b.id })}
              className="text-xs text-emerald-600 hover:text-emerald-800"
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
        <h1 className="page-title">Brokers</h1>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="btn btn-md btn-primary"
        >
          {showForm ? 'Cancel' : 'Add Broker'}
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input tabIndex={1} autoFocus value={name} onChange={(e) => setName(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Phone</label>
              <input tabIndex={2} value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Email</label>
              <input tabIndex={3} value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">RERA Agent No.</label>
              <input tabIndex={4} value={reraAgentNo} onChange={(e) => setReraAgentNo(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">PAN (encrypted at rest)</label>
              <input tabIndex={5} value={pan} onChange={(e) => setPan(e.target.value)} placeholder="ABCDE1234F" className="mt-1 input" />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              tabIndex={6}
              onClick={handleCreate}
              disabled={!name || !phone || createMutation.isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Saving…' : 'Create Broker'}
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} emptyText="No brokers yet" />
        {data?.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
      </div>
    </div>
  );
}
