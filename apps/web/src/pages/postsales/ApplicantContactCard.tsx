import { useState } from 'react';
import { api, type ApiError } from '../../lib/api';

export interface ApplicantContact {
  id: string;
  name: string;
  primaryPhone: string;
  email: string | null;
  addressLine1?: string | null;
  city: string | null;
  state?: string | null;
  pincode?: string | null;
}

interface Duplicate {
  id: string;
  name: string;
  primaryPhone: string;
}

const FIELDS = [
  ['name', 'Name'],
  ['primaryPhone', 'Phone'],
  ['email', 'Email'],
  ['addressLine1', 'Address'],
  ['city', 'City'],
  ['state', 'State'],
  ['pincode', 'PIN code'],
] as const;

/**
 * "Edit contact" on Applicant 360 (presales.applicant.update). Sends only the
 * fields that changed. A phone or email another person has comes back as a
 * list of matches: the user can confirm they are different people and save,
 * or change the value. Changing the phone or email a portal customer signs in
 * with needs an admin, moves their login and signs them out (the server
 * enforces and explains it).
 */
export default function ApplicantContactCard({ applicant, onSaved }: { applicant: ApplicantContact; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function start() {
    setForm(Object.fromEntries(FIELDS.map(([k]) => [k, (applicant[k] as string | null | undefined) ?? ''])));
    setDuplicates(null);
    setError('');
    setEditing(true);
  }

  async function save(confirmDistinct = false) {
    setError('');
    const body: Record<string, unknown> = {};
    for (const [k] of FIELDS) {
      const was = (applicant[k] as string | null | undefined) ?? '';
      if (form[k].trim() !== was && form[k].trim() !== '') body[k] = form[k].trim();
    }
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    if (confirmDistinct) body.confirmDistinct = true;
    setSaving(true);
    try {
      await api(`/applicants/${applicant.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setEditing(false);
      setDuplicates(null);
      onSaved();
    } catch (err) {
      const dups = ((err as ApiError).body as { duplicates?: Duplicate[] } | undefined)?.duplicates;
      if (dups?.length) setDuplicates(dups);
      else setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button onClick={start} className="btn btn-sm btn-secondary">
        Edit contact
      </button>
    );
  }

  return (
    <section aria-labelledby="edit-contact-title" className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
      <h2 id="edit-contact-title" className="section-title">Edit contact</h2>
      <p className="mt-1 text-xs text-slate-600">
        If this customer signs in to the portal with this phone or email, changing it moves their login and signs them out; only an
        admin can do that.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <label htmlFor={`contact-${k}`} className="block text-sm font-medium text-slate-700">{label}</label>
            <input
              id={`contact-${k}`}
              type={k === 'email' ? 'email' : 'text'}
              value={form[k] ?? ''}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              className="mt-1 input"
            />
          </div>
        ))}
      </div>
      {duplicates && (
        <div role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Another person already has this phone or email:</p>
          <ul className="mt-1 list-disc pl-5">
            {duplicates.map((d) => (
              <li key={d.id}>{d.name} — {d.primaryPhone}</li>
            ))}
          </ul>
          <p className="mt-1">Save only if they are a different person (this is recorded). Merging records isn&apos;t available here.</p>
          <button onClick={() => save(true)} disabled={saving} className="btn btn-sm btn-secondary mt-2">
            They&apos;re different people — save
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <button onClick={() => save(false)} disabled={saving} className="btn btn-md btn-primary">
          {saving ? 'Saving…' : 'Save contact'}
        </button>
        <button onClick={() => setEditing(false)} className="btn btn-md btn-secondary">Cancel</button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
