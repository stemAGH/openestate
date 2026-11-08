import { useState } from 'react';
import { LETTER_TEMPLATE_ENTITY_TYPES, MERGE_FIELD_REGISTRY, type GeneratedDocumentTypeValue } from '@openestate/shared';
import { usePaginatedQuery, useApiMutation } from '../../lib/hooks';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';

interface LetterTemplate {
  id: string;
  name: string;
  subject: string;
  entityType: string;
  isActive: boolean;
}

export default function LetterTemplatesPage() {
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [entityType, setEntityType] = useState<(typeof LETTER_TEMPLATE_ENTITY_TYPES)[number]>('ALLOTMENT_LETTER');
  const [body, setBody] = useState('');

  const { data, isLoading } = usePaginatedQuery<LetterTemplate>(['letter-templates'], '/masters/letter-templates', { page, limit: 20 });
  const create = useApiMutation<LetterTemplate, Record<string, unknown>>('POST', '/masters/letter-templates', [['letter-templates']]);

  async function handleCreate() {
    setError('');
    try {
      await create.mutateAsync({ name, subject, entityType, body, isActive: true, sortOrder: 0 });
      setShowForm(false);
      setName('');
      setSubject('');
      setBody('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const columns: Column<LetterTemplate>[] = [
    { key: 'name', header: 'Name', render: (t) => t.name },
    { key: 'entityType', header: 'Type', render: (t) => t.entityType },
    { key: 'subject', header: 'Subject', render: (t) => t.subject },
    { key: 'isActive', header: 'Active', render: (t) => (t.isActive ? 'Yes' : 'No') },
  ];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="page-title">Letter Templates</h1>
        <button onClick={() => setShowForm(true)} className="btn btn-md btn-primary">
          Add Template
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Type</label>
              <select
                value={entityType}
                onChange={(e) => setEntityType(e.target.value as typeof entityType)}
                className="mt-1 input"
              >
                {LETTER_TEMPLATE_ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 input" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Body</label>
              <p className="mt-1 text-xs text-slate-500">
                Merge fields: {MERGE_FIELD_REGISTRY[entityType as GeneratedDocumentTypeValue].map((f) => `{{${f}}}`).join(', ')}
              </p>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-3">
            <button onClick={handleCreate} className="btn btn-md btn-primary">Create</button>
            <button onClick={() => setShowForm(false)} className="btn btn-md btn-secondary">Cancel</button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />
        {data?.meta && <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />}
      </div>
    </div>
  );
}
