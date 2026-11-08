import { useState } from 'react';
import { api } from '../../lib/api';
import { usePaginatedQuery } from '../../lib/hooks';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';

interface LeadStage {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  isDefault: boolean;
}

export default function LeadStagesPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, refetch } = usePaginatedQuery<LeadStage>(['lead-stages'], '/masters/lead-stages', { page, limit: 50 });

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSortOrder, setCreateSortOrder] = useState(0);
  const [createIsDefault, setCreateIsDefault] = useState(false);
  const [createError, setCreateError] = useState('');

  const [editItem, setEditItem] = useState<LeadStage | null>(null);
  const [editName, setEditName] = useState('');
  const [editSortOrder, setEditSortOrder] = useState(0);
  const [editIsActive, setEditIsActive] = useState(true);
  const [editIsDefault, setEditIsDefault] = useState(false);
  const [editError, setEditError] = useState('');

  // Set only once occupancy is actually known to be > 0 for the stage
  // being deactivated — drives the confirmation block, same pattern as
  // ProjectDetail.tsx's areaLocationId booking-count confirmation.
  const [occupantCount, setOccupantCount] = useState<number | null>(null);
  const [reassignToStageId, setReassignToStageId] = useState('');

  function openEdit(item: LeadStage) {
    setEditItem(item);
    setEditName(item.name);
    setEditSortOrder(item.sortOrder);
    setEditIsActive(item.isActive);
    setEditIsDefault(item.isDefault);
    setOccupantCount(null);
    setReassignToStageId('');
    setEditError('');
  }

  async function handleCreate() {
    setCreateError('');
    try {
      await api('/masters/lead-stages', {
        method: 'POST',
        body: JSON.stringify({ name: createName, sortOrder: createSortOrder, isDefault: createIsDefault }),
      });
      setShowCreateForm(false);
      setCreateName('');
      setCreateSortOrder(0);
      setCreateIsDefault(false);
      refetch();
    } catch (err) {
      setCreateError((err as Error).message);
    }
  }

  async function submitEdit(reassignTo?: string) {
    if (!editItem) return;
    setEditError('');
    try {
      await api(`/masters/lead-stages/${editItem.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          sortOrder: editSortOrder,
          isActive: editIsActive,
          isDefault: editIsDefault,
          ...(reassignTo ? { reassignToStageId: reassignTo } : {}),
        }),
      });
      setEditItem(null);
      setOccupantCount(null);
      refetch();
    } catch (err) {
      setEditError((err as Error).message);
    }
  }

  async function handleSaveEdit() {
    if (!editItem) return;
    const deactivating = editIsActive === false && editItem.isActive === true;
    if (deactivating && occupantCount === null) {
      const { count } = await api<{ count: number }>(`/masters/lead-stages/${editItem.id}/occupancy`);
      if (count > 0) {
        setOccupantCount(count);
        return;
      }
    }
    await submitEdit(occupantCount && occupantCount > 0 ? reassignToStageId : undefined);
  }

  const columns: Column<LeadStage>[] = [
    { key: 'sortOrder', header: 'Order', render: (s) => s.sortOrder },
    { key: 'name', header: 'Name', render: (s) => s.name },
    { key: 'isDefault', header: 'Default', render: (s) => (s.isDefault ? 'Yes' : 'No') },
    { key: 'isActive', header: 'Active', render: (s) => (s.isActive ? 'Yes' : 'No') },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <button onClick={() => openEdit(s)} className="text-sm font-medium text-blue-600 hover:text-blue-800">
          Edit
        </button>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Lead Stages</h1>
        <button onClick={() => setShowCreateForm(true)} className="btn btn-md btn-primary">
          Add Stage
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Company-configurable pipeline position — separate from an inquiry&apos;s Open/Continued/Dumped/Successful status.
      </p>

      {showCreateForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Sort Order</label>
              <input type="number" value={createSortOrder} onChange={(e) => setCreateSortOrder(Number(e.target.value))} className="mt-1 input" />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={createIsDefault} onChange={(e) => setCreateIsDefault(e.target.checked)} />
                Default stage for new leads
              </label>
            </div>
          </div>
          <div className="mt-3 flex gap-3">
            <button onClick={handleCreate} className="btn btn-md btn-primary">Create</button>
            <button onClick={() => setShowCreateForm(false)} className="btn btn-md btn-secondary">Cancel</button>
          </div>
          {createError && <p className="mt-2 text-sm text-red-600">{createError}</p>}
        </div>
      )}

      {editItem && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Sort Order</label>
              <input type="number" value={editSortOrder} onChange={(e) => setEditSortOrder(Number(e.target.value))} className="mt-1 input" />
            </div>
            <div className="flex items-end gap-4 pb-2">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={editIsActive} onChange={(e) => { setEditIsActive(e.target.checked); setOccupantCount(null); }} />
                Active
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={editIsDefault} onChange={(e) => setEditIsDefault(e.target.checked)} />
                Default
              </label>
            </div>
          </div>

          {occupantCount !== null && occupantCount > 0 && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm text-amber-900">
                This stage has {occupantCount} active lead{occupantCount === 1 ? '' : 's'}. Pick a stage to move them to before deactivating.
              </p>
              <select aria-label="Reassign to" value={reassignToStageId} onChange={(e) => setReassignToStageId(e.target.value)} className="mt-2 rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select…</option>
                {data?.data?.filter((s) => s.id !== editItem.id).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <div className="mt-3 flex gap-3">
                <button onClick={handleSaveEdit} disabled={!reassignToStageId} className="btn btn-md btn-warning">
                  Reassign and deactivate
                </button>
                <button onClick={() => setOccupantCount(null)} className="btn btn-md btn-secondary">Cancel</button>
              </div>
            </div>
          )}

          {occupantCount === null && (
            <div className="mt-3 flex gap-3">
              <button onClick={handleSaveEdit} className="btn btn-md btn-primary">Save</button>
              <button onClick={() => setEditItem(null)} className="btn btn-md btn-secondary">Cancel</button>
            </div>
          )}
          {editError && <p className="mt-2 text-sm text-red-600">{editError}</p>}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />
        {data?.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
      </div>
    </div>
  );
}
