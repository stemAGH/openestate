import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatInr } from '@openestate/shared';
import { api, downloadFile } from '../../lib/api';

interface ApplicantRow {
  id: string;
  name: string;
  primaryPhone: string;
}

interface BookingRow {
  id: string;
  bookingNumber: string;
  // floor is null for a LAND_BASED unit (Phase A) — every read must check
  // it, not assume it, per plotted-farmhouse-inventory.md §13.1.
  unit: { number: string; floor: { tower: { name: string } } | null };
}

interface Installment {
  id: string;
  seq: number;
  label: string;
  /** Null for an unraised STAGE_LINKED installment. */
  dueDate: string | null;
  amountPaise: string;
  allocatedPaise: string;
  status: string;
}

interface PlanVersion {
  id: string;
  isActive: boolean;
  installments: Installment[];
}

interface BankRow {
  id: string;
  name: string;
}

const CHEQUE_LIKE = new Set(['CHEQUE', 'DD']);
const MODES = ['CASH', 'CHEQUE', 'DD', 'NEFT', 'RTGS', 'UPI', 'CARD'];

export default function ReceiptEntry() {
  const [phoneSearch, setPhoneSearch] = useState('');
  const [applicant, setApplicant] = useState<ApplicantRow | null>(null);
  const [bookingId, setBookingId] = useState('');
  const [receiptDate, setReceiptDate] = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState('NEFT');
  const [grossRupees, setGrossRupees] = useState('');
  const [bankId, setBankId] = useState('');
  const [instrumentNumber, setInstrumentNumber] = useState('');
  const [instrumentDate, setInstrumentDate] = useState('');
  const [utr, setUtr] = useState('');
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ receiptNumber: string; documentId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const grossInputRef = useRef<HTMLInputElement>(null);

  const { data: applicantResults } = useQuery<{ data: ApplicantRow[] }>({
    queryKey: ['receipt-applicant-search', phoneSearch],
    queryFn: () => api(`/applicants?search=${encodeURIComponent(phoneSearch)}&limit=10`),
    enabled: phoneSearch.length >= 3 && !applicant,
  });

  const { data: threeSixty } = useQuery<{ bookings: BookingRow[] }>({
    queryKey: ['applicant-360-bookings', applicant?.id],
    queryFn: () => api(`/applicants/${applicant!.id}/360`),
    enabled: !!applicant,
  });

  const { data: planVersions } = useQuery<PlanVersion[]>({
    queryKey: ['plan-history', bookingId],
    queryFn: () => api(`/bookings/${bookingId}/plan-history`),
    enabled: !!bookingId,
  });

  const activePlan = planVersions?.find((v) => v.isActive);
  // An unraised STAGE_LINKED installment (dueDate === null) is excluded
  // here at ALLOCATION time, not at receipt-creation time — the receipt
  // itself is never refused (a customer paying ahead of a milestone is
  // normal); what's refused is applying that money against a stage the
  // builder hasn't reached yet, since nothing is actually due against it.
  // See internal plan construction-linked-demand-fix.md revision 2,
  // clarification 1.
  const dueInstallments = useMemo(
    () =>
      (activePlan?.installments ?? [])
        .filter((i): i is Installment & { dueDate: string } => i.dueDate !== null && BigInt(i.amountPaise) - BigInt(i.allocatedPaise) > 0n)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [activePlan],
  );

  const grossPaise = grossRupees ? BigInt(Math.round(Number(grossRupees) * 100)) : 0n;
  const allocatedTotal = Object.values(allocations).reduce((sum, v) => sum + (v ? BigInt(Math.round(Number(v) * 100)) : 0n), 0n);

  function autoFillOldestFirst() {
    let remaining = grossPaise;
    const next: Record<string, string> = {};
    for (const inst of dueInstallments) {
      if (remaining <= 0n) break;
      const due = BigInt(inst.amountPaise) - BigInt(inst.allocatedPaise);
      const take = due < remaining ? due : remaining;
      next[inst.id] = (Number(take) / 100).toString();
      remaining -= take;
    }
    setAllocations(next);
  }

  function reset() {
    setPhoneSearch('');
    setApplicant(null);
    setBookingId('');
    setGrossRupees('');
    setAllocations({});
    setInstrumentNumber('');
    setInstrumentDate('');
    setUtr('');
    setBankId('');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess(null);
    setSubmitting(true);
    try {
      const allocationList = Object.entries(allocations)
        .filter(([, v]) => v && Number(v) > 0)
        .map(([installmentId, v]) => ({ installmentId, amountPaise: String(Math.round(Number(v) * 100)) }));

      if (allocationList.length === 0) throw new Error('Allocate the receipt to at least one installment');

      const receipt = await api<{ id: string; receiptNumber: string }>('/receipts', {
        method: 'POST',
        body: JSON.stringify({
          bookingId,
          receiptDate,
          mode,
          grossAmountPaise: grossPaise.toString(),
          allocations: allocationList,
          bankId: CHEQUE_LIKE.has(mode) && bankId ? bankId : undefined,
          instrumentNumber: CHEQUE_LIKE.has(mode) && instrumentNumber ? instrumentNumber : undefined,
          instrumentDate: CHEQUE_LIKE.has(mode) && instrumentDate ? instrumentDate : undefined,
          utr: mode === 'NEFT' || mode === 'RTGS' || mode === 'UPI' ? utr || undefined : undefined,
        }),
      });

      let documentId: string | undefined;
      try {
        const doc = await api<{ id: string }>(`/receipts/${receipt.id}/pdf`, { method: 'POST' });
        documentId = doc.id;
        await downloadFile(`/documents/${doc.id}/download`, `${receipt.receiptNumber.replace(/\//g, '-')}.pdf`);
      } catch {
        // Receipt is saved either way; PDF generation/download failing shouldn't block the entry flow.
      }

      setSuccess({ receiptNumber: receipt.receiptNumber, documentId });
      reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const { data: banks } = useQuery<{ data: BankRow[] }>({
    queryKey: ['banks-all'],
    queryFn: () => api('/masters/banks?limit=100'),
    enabled: CHEQUE_LIKE.has(mode),
  });

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-slate-900">Receipt Entry</h1>
      <p className="mt-1 text-xs text-slate-500">Tab moves through fields in order; Enter submits.</p>

      {success && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          Receipt {success.receiptNumber} saved.{' '}
          {success.documentId ? 'PDF downloaded.' : 'PDF generation failed — you can reprint it from Applicant 360 later.'}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={onSubmit} className="mt-6 space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        <div>
          <label className="block text-sm font-medium text-slate-700">Applicant phone / name</label>
          {applicant ? (
            <div className="mt-1 flex items-center justify-between rounded-md bg-blue-50 px-3 py-2 text-sm">
              <span className="font-medium text-blue-900">{applicant.name} — {applicant.primaryPhone}</span>
              <div className="flex items-center gap-3">
                <Link to={`/postsales/applicants/${applicant.id}`} className="text-xs text-blue-600 hover:text-blue-800">
                  View ledger
                </Link>
                <button type="button" tabIndex={-1} onClick={() => { setApplicant(null); setBookingId(''); }} className="text-xs text-blue-600 hover:text-blue-800">
                  Change
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                tabIndex={1}
                autoFocus
                type="text"
                value={phoneSearch}
                onChange={(e) => setPhoneSearch(e.target.value)}
                placeholder="98765xxxxx"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {applicantResults && applicantResults.data.length > 0 && (
                <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white">
                  {applicantResults.data.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      tabIndex={-1}
                      onClick={() => setApplicant(a)}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      {a.name} — {a.primaryPhone}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {applicant && (
          <div>
            <label className="block text-sm font-medium text-slate-700">Booking</label>
            <select
              tabIndex={2}
              value={bookingId}
              onChange={(e) => setBookingId(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Select booking</option>
              {threeSixty?.bookings?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.bookingNumber} — {b.unit.floor ? `${b.unit.floor.tower.name}/` : ''}{b.unit.number}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">Receipt date</label>
            <input
              tabIndex={3}
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Mode</label>
            <select
              tabIndex={4}
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>

        {CHEQUE_LIKE.has(mode) && (
          <div className="grid grid-cols-3 gap-4 rounded-md bg-slate-50 p-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">Bank</label>
              <select tabIndex={5} value={bankId} onChange={(e) => setBankId(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                <option value="">—</option>
                {banks?.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Instrument #</label>
              <input tabIndex={6} type="text" value={instrumentNumber} onChange={(e) => setInstrumentNumber(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Instrument date</label>
              <input tabIndex={7} type="date" value={instrumentDate} onChange={(e) => setInstrumentDate(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            </div>
          </div>
        )}
        {(mode === 'NEFT' || mode === 'RTGS' || mode === 'UPI') && (
          <div>
            <label className="block text-xs font-medium text-slate-700">UTR / reference</label>
            <input tabIndex={5} type="text" value={utr} onChange={(e) => setUtr(e.target.value)} className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700">Gross amount received (₹)</label>
          <input
            ref={grossInputRef}
            tabIndex={8}
            type="number"
            min={0}
            value={grossRupees}
            onChange={(e) => setGrossRupees(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {bookingId && (
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">Allocate to installments</label>
              <button type="button" tabIndex={9} onClick={autoFillOldestFirst} className="text-xs font-medium text-blue-600 hover:text-blue-800">
                Auto-fill oldest-dues-first
              </button>
            </div>
            <div className="mt-2 space-y-1">
              {dueInstallments.map((inst, i) => {
                const due = BigInt(inst.amountPaise) - BigInt(inst.allocatedPaise);
                return (
                  <div key={inst.id} className="flex items-center gap-2 text-sm">
                    <span className="w-40 truncate">{inst.label}</span>
                    <span className="w-32 text-xs text-slate-500">Due {formatInr(due)}</span>
                    <input
                      tabIndex={10 + i}
                      type="number"
                      min={0}
                      value={allocations[inst.id] ?? ''}
                      onChange={(e) => setAllocations({ ...allocations, [inst.id]: e.target.value })}
                      className="w-28 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                  </div>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Allocated {formatInr(allocatedTotal)} of {formatInr(grossPaise)}
            </p>
          </div>
        )}

        <button
          tabIndex={30}
          type="submit"
          disabled={submitting || !bookingId || grossPaise <= 0n}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save & Print Receipt'}
        </button>
      </form>
    </div>
  );
}
