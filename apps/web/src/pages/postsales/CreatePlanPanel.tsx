import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInr } from '@openestate/shared';
import { api } from '../../lib/api';
import PlanInstallmentsEditor, { planMatchesTotal, type InstallmentRow } from './PlanInstallmentsEditor';

/**
 * For a booking with no payment plan (left by the old two-step booking, or
 * created through the deprecated POST /bookings): attach one. The plan is
 * checked against the booking's GST-inclusive agreed price, the same check
 * the server makes.
 */
export default function CreatePlanPanel({
  bookingId,
  agreedPricePaise,
  bookingDate,
}: {
  bookingId: string;
  agreedPricePaise: string;
  bookingDate: string;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'template' | 'custom'>('custom');
  const [templateId, setTemplateId] = useState('');
  const [rows, setRows] = useState<InstallmentRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const total = BigInt(agreedPricePaise);
  const dueDefault = bookingDate.slice(0, 10);

  const { data: templates } = useQuery<{ data: Array<{ id: string; name: string }> }>({
    queryKey: ['payment-plan-templates'],
    queryFn: () => api('/masters/payment-plan-templates?limit=100'),
  });

  const valid = mode === 'template' ? !!templateId : planMatchesTotal(rows, total);

  async function create() {
    setSaving(true);
    setError('');
    try {
      if (mode === 'template') {
        await api(`/bookings/${bookingId}/plan/from-template`, { method: 'POST', body: JSON.stringify({ templateId }) });
      } else {
        await api(`/bookings/${bookingId}/plan/custom`, {
          method: 'POST',
          body: JSON.stringify({ name: 'Custom Plan', isCustom: true, installments: rows }),
        });
      }
      await qc.invalidateQueries({ queryKey: ['plan-history', bookingId] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4" aria-labelledby="create-plan-heading">
      <h2 id="create-plan-heading" className="text-sm font-semibold text-amber-900">This booking has no payment plan</h2>
      <p className="mt-1 text-sm text-amber-800">
        Add one, or cancel the booking. The installments must add up to the agreed price,{' '}
        <strong>{formatInr(total)}</strong> (GST included).
      </p>
      <div className="mt-3 flex gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === 'custom'} onChange={() => setMode('custom')} />
          Custom schedule
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === 'template'} onChange={() => setMode('template')} />
          From template
        </label>
      </div>
      {mode === 'template' ? (
        <select
          aria-label="Payment plan template"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          className="mt-3 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">Select a template</option>
          {templates?.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      ) : (
        <PlanInstallmentsEditor rows={rows} onChange={setRows} totalPaise={total} defaultDueDate={dueDefault} />
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={!valid || saving}
        onClick={create}
        className="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Create payment plan'}
      </button>
    </section>
  );
}
