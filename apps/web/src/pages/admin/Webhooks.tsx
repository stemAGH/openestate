import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import DataTable, { type Column } from '../../components/DataTable';

interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  isActive: boolean;
  consecutiveFailures: number;
  disabledReason: string | null;
}

interface WebhookDelivery {
  id: string;
  eventType: string;
  status: string;
  attemptCount: number;
  createdAt: string;
}

export default function WebhooksPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const [formData, setFormData] = useState({ name: '', url: '', secret: '', eventTypes: '' });
  const [formError, setFormError] = useState('');

  const { data: endpoints, isLoading } = useQuery<WebhookEndpoint[]>({
    queryKey: ['webhook-endpoints'],
    queryFn: () => api('/admin/webhook-endpoints'),
  });

  const { data: deliveries } = useQuery<WebhookDelivery[]>({
    queryKey: ['webhook-deliveries', selectedId],
    queryFn: () => api(`/admin/webhook-deliveries?webhookEndpointId=${selectedId}`),
    enabled: !!selectedId,
  });

  const handleCreate = async () => {
    setFormError('');
    try {
      await api('/admin/webhook-endpoints', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.name,
          url: formData.url,
          secret: formData.secret,
          eventTypes: formData.eventTypes.split(',').map((e) => e.trim()).filter(Boolean),
        }),
      });
      qc.invalidateQueries({ queryKey: ['webhook-endpoints'] });
      setShowForm(false);
      setFormData({ name: '', url: '', secret: '', eventTypes: '' });
    } catch (err) {
      setFormError((err as Error).message);
      toast.error((err as Error).message);
    }
  };

  const toggle = async (id: string, isActive: boolean) => {
    try {
      await api(`/admin/webhook-endpoints/${id}/${isActive ? 'disable' : 'enable'}`, { method: 'POST' });
      qc.invalidateQueries({ queryKey: ['webhook-endpoints'] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this webhook endpoint? Its delivery history will be deleted too.')) return;
    try {
      await api(`/admin/webhook-endpoints/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['webhook-endpoints'] });
      if (selectedId === id) setSelectedId(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const sendTest = async (id: string) => {
    setTestMessage('Sending…');
    try {
      await api(`/admin/webhook-endpoints/${id}/test`, { method: 'POST' });
      setTestMessage('Test event queued — check the delivery list below in a few seconds.');
      setSelectedId(id);
      setTimeout(() => qc.invalidateQueries({ queryKey: ['webhook-deliveries', id] }), 1500);
    } catch (err) {
      setTestMessage('');
      toast.error((err as Error).message);
    }
  };

  const columns: Column<WebhookEndpoint>[] = [
    { key: 'name', header: 'Name', render: (e) => e.name },
    { key: 'url', header: 'URL', render: (e) => <span className="font-mono text-xs">{e.url}</span> },
    { key: 'events', header: 'Events', render: (e) => e.eventTypes.join(', ') },
    {
      key: 'status',
      header: 'Status',
      render: (e) => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${e.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
          {e.isActive ? 'Active' : `Disabled${e.disabledReason ? `: ${e.disabledReason}` : ''}`}
        </span>
      ),
    },
    { key: 'failures', header: 'Consecutive Failures', render: (e) => e.consecutiveFailures },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (e) => (
        <div className="flex justify-end gap-2">
          <button onClick={() => setSelectedId(e.id)} className="text-blue-600 hover:text-blue-800 text-xs">
            Deliveries
          </button>
          <button onClick={() => sendTest(e.id)} className="text-slate-600 hover:text-slate-800 text-xs">
            Send Test
          </button>
          <button onClick={() => toggle(e.id, e.isActive)} className="text-slate-600 hover:text-slate-800 text-xs">
            {e.isActive ? 'Disable' : 'Enable'}
          </button>
          <button onClick={() => remove(e.id)} className="text-red-600 hover:text-red-800 text-xs">
            Delete
          </button>
        </div>
      ),
    },
  ];

  const deliveryColumns: Column<WebhookDelivery>[] = [
    { key: 'eventType', header: 'Event', render: (d) => d.eventType },
    {
      key: 'status',
      header: 'Status',
      render: (d) => {
        const cls =
          d.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-800' : d.status === 'EXHAUSTED' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800';
        return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{d.status}</span>;
      },
    },
    { key: 'attempts', header: 'Attempts', render: (d) => d.attemptCount },
    { key: 'createdAt', header: 'Created', render: (d) => new Date(d.createdAt).toLocaleString() },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Webhooks</h1>
        <button
          onClick={() => setShowForm(true)}
          className="btn btn-md btn-primary"
        >
          Add Endpoint
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                className="mt-1 input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">URL</label>
              <input
                type="text"
                value={formData.url}
                onChange={(e) => setFormData((p) => ({ ...p, url: e.target.value }))}
                placeholder="https://example.com/webhook"
                className="mt-1 input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Signing Secret</label>
              <input
                type="text"
                value={formData.secret}
                onChange={(e) => setFormData((p) => ({ ...p, secret: e.target.value }))}
                placeholder="At least 16 characters"
                className="mt-1 input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Event Types (comma-separated)</label>
              <input
                type="text"
                value={formData.eventTypes}
                onChange={(e) => setFormData((p) => ({ ...p, eventTypes: e.target.value }))}
                placeholder="booking.created, receipt.created"
                className="mt-1 input"
              />
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              className="btn btn-md btn-primary"
            >
              Create
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="btn btn-md btn-secondary"
            >
              Cancel
            </button>
          </div>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
        </div>
      )}

      {testMessage && <p className="mt-3 text-sm text-slate-600">{testMessage}</p>}

      <div className="mt-4">
        <DataTable columns={columns} data={endpoints ?? []} isLoading={isLoading} />
      </div>

      {selectedId && (
        <div className="mt-6">
          <h2 className="section-title">Recent Deliveries</h2>
          <div className="mt-2">
            <DataTable columns={deliveryColumns} data={deliveries ?? []} emptyText="No deliveries yet." />
          </div>
        </div>
      )}
    </div>
  );
}
