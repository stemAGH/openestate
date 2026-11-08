import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_ENTITIES,
  supportsCustomFieldValues,
} from '@openestate/shared';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import DataTable, { type Column } from '../../components/DataTable';

interface CustomField {
  id: string;
  entityType: string;
  key: string;
  fieldType: string;
  label: string;
  isRequired: boolean;
  options: string[] | null;
  isActive: boolean;
  sortOrder: number;
  allowsTwelveDigitValues: boolean;
}

interface PurgeTarget {
  field: CustomField;
  affectedRows: number;
}

export default function CustomFieldsPage() {
  const [selectedEntity, setSelectedEntity] = useState<(typeof CUSTOM_FIELD_ENTITIES)[number]>(CUSTOM_FIELD_ENTITIES[0]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    key: '',
    fieldType: CUSTOM_FIELD_TYPES[0] as (typeof CUSTOM_FIELD_TYPES)[number],
    label: '',
    isRequired: false,
    options: '',
    allowsTwelveDigitValues: false,
  });
  const [formError, setFormError] = useState('');
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [purgeError, setPurgeError] = useState('');
  const [exemptTarget, setExemptTarget] = useState<CustomField | null>(null);
  const qc = useQueryClient();

  const entitySupported = supportsCustomFieldValues(selectedEntity);

  const { data: fields, isLoading } = useQuery<CustomField[]>({
    queryKey: ['custom-fields', selectedEntity],
    queryFn: () => api(`/custom-fields?entityType=${selectedEntity}`),
  });

  const handleCreate = async () => {
    setFormError('');
    try {
      const body: Record<string, unknown> = {
        entityType: selectedEntity,
        key: formData.key,
        fieldType: formData.fieldType,
        label: formData.label,
        isRequired: formData.isRequired,
        allowsTwelveDigitValues: formData.allowsTwelveDigitValues,
      };
      if (['SELECT', 'MULTI_SELECT'].includes(formData.fieldType) && formData.options) {
        body.options = formData.options.split(',').map((o) => o.trim());
      }
      await api('/custom-fields', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      qc.invalidateQueries({ queryKey: ['custom-fields', selectedEntity] });
      setShowForm(false);
      setFormData({ key: '', fieldType: CUSTOM_FIELD_TYPES[0], label: '', isRequired: false, options: '', allowsTwelveDigitValues: false });
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  // Soft delete: the field stops appearing on forms and stops being
  // enforced, but every stored value is preserved. Destroying values is
  // a separate, explicitly-confirmed action (handlePurge below).
  const handleDeactivate = async (id: string) => {
    if (!confirm('Deactivate this field? It will stop appearing on forms. Stored values are kept.')) return;
    try {
      await api(`/custom-fields/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['custom-fields', selectedEntity] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Turning the check OFF asks for confirmation (in the page, not a native
  // dialog); turning it back ON is the safe direction and needs none.
  const setExemption = async (field: CustomField, allow: boolean) => {
    try {
      await api(`/custom-fields/${field.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ allowsTwelveDigitValues: allow }),
      });
      qc.invalidateQueries({ queryKey: ['custom-fields', selectedEntity] });
      setExemptTarget(null);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const openPurge = async (field: CustomField) => {
    setPurgeConfirm('');
    setPurgeError('');
    try {
      const res = await api<{ affectedRows: number }>(`/custom-fields/${field.id}/value-count`);
      setPurgeTarget({ field, affectedRows: res.affectedRows });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handlePurge = async () => {
    if (!purgeTarget) return;
    setPurgeError('');
    try {
      await api(`/custom-fields/${purgeTarget.field.id}/purge`, {
        method: 'POST',
        body: JSON.stringify({ confirmKey: purgeConfirm }),
      });
      qc.invalidateQueries({ queryKey: ['custom-fields', selectedEntity] });
      setPurgeTarget(null);
      setPurgeConfirm('');
    } catch (err) {
      setPurgeError((err as Error).message);
    }
  };

  const columns: Column<CustomField>[] = [
    {
      key: 'label',
      header: 'Label',
      render: (f) => (
        <span>
          {f.label}
          {f.allowsTwelveDigitValues && (
            <span className="ml-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              ⚠ 12-digit check disabled
            </span>
          )}
        </span>
      ),
    },
    { key: 'key', header: 'Field Name', render: (f) => f.key },
    {
      key: 'type',
      header: 'Type',
      render: (f) => (
        <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {f.fieldType}
        </span>
      ),
    },
    {
      key: 'required',
      header: 'Required',
      render: (f) => (f.isRequired ? 'Yes' : 'No'),
    },
    {
      key: 'options',
      header: 'Options',
      render: (f) => (f.options ? f.options.join(', ') : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      render: (f) =>
        f.isActive ? (
          <span className="text-green-700 text-xs">Active</span>
        ) : (
          <span className="text-slate-400 text-xs">Inactive</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (f) => (
        <span className="space-x-3">
          {f.allowsTwelveDigitValues ? (
            <button onClick={() => setExemption(f, false)} className="text-blue-700 hover:text-blue-900 text-xs">
              Re-enable check
            </button>
          ) : (
            <button onClick={() => setExemptTarget(f)} className="text-slate-600 hover:text-slate-900 text-xs">
              Allow 12-digit values
            </button>
          )}
          {f.isActive && (
            <button
              onClick={() => handleDeactivate(f.id)}
              className="text-amber-700 hover:text-amber-900 text-xs"
            >
              Deactivate
            </button>
          )}
          <button
            onClick={() => openPurge(f)}
            className="text-red-600 hover:text-red-800 text-xs"
          >
            Delete permanently
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <h1 className="page-title">Custom Fields</h1>

      <div className="mt-4 flex flex-wrap gap-2">
        {CUSTOM_FIELD_ENTITIES.map((entity) => (
          <button
            key={entity}
            onClick={() => {
              setSelectedEntity(entity);
              setShowForm(false);
            }}
            className={`rounded-md px-3 py-1.5 text-sm ${
              selectedEntity === entity
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            {entity}
            {!supportsCustomFieldValues(entity) && (
              <span className="ml-1 text-xs opacity-70">(unsupported)</span>
            )}
          </button>
        ))}
      </div>

      {!entitySupported && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Custom fields are not supported for {selectedEntity} yet.</strong> There is nowhere
          to store a value for this entity, so defining a field here would have no effect anywhere
          in the product. Adding support requires changes to the booking service, which is
          deliberately frozen — ask before it is enabled.
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <h2 className="section-title">{selectedEntity} Fields</h2>
        <button
          onClick={() => setShowForm(true)}
          disabled={!entitySupported}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add Field
        </button>
      </div>

      {purgeTarget && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4">
          <h3 className="text-sm font-semibold text-red-900">
            Permanently delete “{purgeTarget.field.label}”?
          </h3>
          <p className="mt-1 text-sm text-red-800">
            This deletes the field definition <strong>and strips its stored value from{' '}
            {purgeTarget.affectedRows} {purgeTarget.affectedRows === 1 ? 'record' : 'records'}</strong>.
            It cannot be undone. If you only want it to stop appearing on forms, use Deactivate
            instead — that keeps the values.
          </p>
          <p className="mt-2 text-sm text-red-800">
            Type <code className="rounded bg-red-100 px-1 font-mono">{purgeTarget.field.key}</code>{' '}
            to confirm:
          </p>
          <input
            type="text"
            value={purgeConfirm}
            onChange={(e) => setPurgeConfirm(e.target.value)}
            placeholder={purgeTarget.field.key}
            className="mt-2 block w-full max-w-sm rounded-md border border-red-300 px-3 py-2 text-sm"
          />
          <div className="mt-3 flex gap-3">
            <button
              data-testid="purge-confirm"
              onClick={handlePurge}
              disabled={purgeConfirm !== purgeTarget.field.key}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Delete permanently
            </button>
            <button
              onClick={() => setPurgeTarget(null)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
          {purgeError && <p className="mt-2 text-sm text-red-700">{purgeError}</p>}
        </div>
      )}

      {exemptTarget && (
        <div data-testid="twelve-digit-confirm-panel" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-900">
            Allow 12-digit values in “{exemptTarget.label}”?
          </h3>
          <p className="mt-1 text-sm text-amber-900">
            Values in this field will no longer be checked for accidentally-stored Aadhaar numbers.
            Do this only for a field that legitimately holds 12-digit numbers, such as a bank account.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              data-testid="twelve-digit-confirm"
              onClick={() => setExemption(exemptTarget, true)}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
            >
              Allow 12-digit values
            </button>
            <button
              onClick={() => setExemptTarget(null)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showForm && entitySupported && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <p data-testid="aadhaar-guard-help" className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
            OpenEstate does not collect Aadhaar numbers. As a safety net against accidental entry, a field
            named after Aadhaar is refused, and a value that looks like an Aadhaar number is refused when
            saved. This is not a guarantee: about 1 in 10 random 12-digit numbers look valid and are
            refused, and a number with a typo, or written with other separators, is not caught. It checks
            custom-field values only — not names, addresses, notes or other free text.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Label</label>
              <input
                type="text"
                value={formData.label}
                onChange={(e) => setFormData((p) => ({ ...p, label: e.target.value }))}
                className="mt-1 input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Field Name</label>
              <input
                type="text"
                value={formData.key}
                onChange={(e) => setFormData((p) => ({ ...p, key: e.target.value }))}
                placeholder="snake_case"
                className="mt-1 input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Type</label>
              <select
                value={formData.fieldType}
                onChange={(e) => setFormData((p) => ({ ...p, fieldType: e.target.value as (typeof CUSTOM_FIELD_TYPES)[number] }))}
                className="mt-1 input"
              >
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.isRequired}
                  onChange={(e) => setFormData((p) => ({ ...p, isRequired: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span className="text-sm text-slate-700">Required</span>
              </label>
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.allowsTwelveDigitValues}
                onChange={(e) => setFormData((p) => ({ ...p, allowsTwelveDigitValues: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              <span className="text-sm text-slate-700">Allow 12-digit values (bypasses the Aadhaar safety check)</span>
            </label>
            <p data-testid="twelve-digit-warning" className="mt-1 text-xs text-amber-800">
              Tick this only if the field legitimately holds a 12-digit number, such as a bank account.
              Values will no longer be checked for accidentally-stored Aadhaar numbers.
            </p>
          </div>

          {['SELECT', 'MULTI_SELECT'].includes(formData.fieldType) && (
            <div>
              <label className="block text-sm font-medium text-slate-700">
                Options (comma-separated)
              </label>
              <input
                type="text"
                value={formData.options}
                onChange={(e) => setFormData((p) => ({ ...p, options: e.target.value }))}
                placeholder="Option 1, Option 2, Option 3"
                className="mt-1 input"
              />
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              className="btn btn-md btn-primary"
            >
              Create Field
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

      <div className="mt-4">
        <DataTable columns={columns} data={fields ?? []} isLoading={isLoading} />
      </div>
    </div>
  );
}
