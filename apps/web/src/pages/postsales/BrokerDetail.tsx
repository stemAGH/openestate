import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  formatInr,
  COMMISSION_TYPE,
  payCommissionPaymentSchema,
  pickForSchema,
  forcePasswordResetResponseSchema,
  NO_PORTAL_ACCOUNT_ERROR,
  PERMISSIONS,
} from '@openestate/shared';
import { api, downloadFile, type ApiError } from '../../lib/api';
import { useApiMutation } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import RevealedResetLink, { ResetLinkSupersedeNote } from '../../components/RevealedResetLink';
import PortalTwoFactorReset from '../../components/PortalTwoFactorReset';

interface Broker {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  reraAgentNo: string | null;
  panMasked: string | null;
  isActive: boolean;
  bankDetails: BankDetail[];
}

interface BankDetail {
  id: string;
  accountHolder: string;
  accountNumber: string;
  ifsc: string;
  bankName: string;
  isPrimary: boolean;
}

interface SlabRow {
  seq: number;
  fromPaise: string;
  toPaise?: string;
  ratePercent: number;
}

interface CommissionRule {
  id: string;
  commissionType: string;
  flatPercent: number | null;
  flatPaise: string | null;
  milestonesJson: number[] | null;
  isActive: boolean;
  slabs: { id: string; seq: number; fromPaise: string; toPaise: string | null; ratePercent: number }[];
}

interface CommissionPayment {
  id: string;
  amountPaise: string;
  status: string;
  mode: string | null;
  createdAt: string;
}

/** Report endpoints yield [broker, bookingNumber, applicant, unit, price, status] tuples, same convention as postsales reports (see Reports.tsx's TupleRows). */
type SoldUnitTuple = [string, string, string, string, string, string];

export default function BrokerDetail() {
  const { brokerId } = useParams<{ brokerId: string }>();
  const { hasPermission } = useAuth();
  const [error, setError] = useState('');

  const canCreatePayment = hasPermission('accounts.commission.create');
  const canApprovePayment = hasPermission('accounts.commission.approve');
  const canPayPayment = hasPermission('accounts.commission.pay');
  const canUpdateBroker = hasPermission('admin.broker.update');
  // The constant, not a string literal like this file's other permission
  // checks — a typo in a literal here would compile clean and silently
  // hide the invite/reset controls; PERMISSIONS.ADMIN_PORTAL_INVITE_SEND
  // can't drift from what the backend actually guards.
  const canManagePortalAccess = hasPermission(PERMISSIONS.ADMIN_PORTAL_INVITE_SEND);

  const { data: broker, refetch: refetchBroker } = useQuery<Broker>({
    queryKey: ['broker', brokerId],
    queryFn: () => api(`/brokers/${brokerId}`),
    enabled: !!brokerId,
  });

  const { data: rules, refetch: refetchRules } = useQuery<CommissionRule[]>({
    queryKey: ['broker-commission-rules', brokerId],
    queryFn: () => api(`/brokers/${brokerId}/commission-rules`),
    enabled: !!brokerId,
  });

  const { data: balance, refetch: refetchBalance } = useQuery<{ balancePaise: string }>({
    queryKey: ['broker-balance', brokerId],
    queryFn: () => api(`/commission-payments/brokers/${brokerId}/balance`),
    enabled: !!brokerId,
  });

  const { data: payments, refetch: refetchPayments } = useQuery<CommissionPayment[]>({
    queryKey: ['broker-payments', brokerId],
    queryFn: () => api(`/commission-payments/brokers/${brokerId}`),
    enabled: !!brokerId,
  });

  const { data: soldUnits } = useQuery<SoldUnitTuple[]>({
    queryKey: ['broker-sold-units', brokerId],
    queryFn: () => api(`/reports/brokers/sold-units?brokerId=${brokerId}`),
    enabled: !!brokerId,
  });

  const { data: pan, refetch: refetchPan } = useQuery<{ pan: string | null }>({
    queryKey: ['broker-pan', brokerId],
    queryFn: () => api(`/brokers/${brokerId}/pan`),
    enabled: false,
  });

  // ── Bank detail form ──
  const [showBankForm, setShowBankForm] = useState(false);
  const [accountHolder, setAccountHolder] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [bankName, setBankName] = useState('');
  const addBankMutation = useApiMutation<unknown, Record<string, unknown>>(
    'POST',
    `/brokers/${brokerId}/bank-details`,
  );

  async function handleAddBank() {
    setError('');
    try {
      await addBankMutation.mutateAsync({ accountHolder, accountNumber, ifsc: ifsc.toUpperCase(), bankName, isPrimary: true });
      setShowBankForm(false);
      setAccountHolder('');
      setAccountNumber('');
      setIfsc('');
      setBankName('');
      refetchBroker();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ── Commission rule form ──
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [commissionType, setCommissionType] = useState<string>(COMMISSION_TYPE.FLAT_PERCENT);
  const [flatPercent, setFlatPercent] = useState('');
  const [flatRupees, setFlatRupees] = useState('');
  const [milestonesText, setMilestonesText] = useState('');
  const [slabs, setSlabs] = useState<SlabRow[]>([{ seq: 1, fromPaise: '0', ratePercent: 1 }]);
  const createRuleMutation = useApiMutation<unknown, Record<string, unknown>>(
    'POST',
    `/brokers/${brokerId}/commission-rules`,
  );

  function addSlabRow() {
    const last = slabs[slabs.length - 1];
    setSlabs([...slabs, { seq: slabs.length + 1, fromPaise: last?.toPaise ?? '0', ratePercent: 1 }]);
  }
  function updateSlab(i: number, patch: Partial<SlabRow>) {
    setSlabs(slabs.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeSlab(i: number) {
    setSlabs(slabs.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, seq: idx + 1 })));
  }

  async function handleCreateRule() {
    setError('');
    try {
      const milestones = milestonesText
        ? milestonesText.split(',').map((m) => Number(m.trim())).filter((m) => !Number.isNaN(m))
        : undefined;
      const body: Record<string, unknown> = {
        brokerId,
        commissionType,
        milestones: milestones && milestones.length > 0 ? milestones : undefined,
      };
      if (commissionType === COMMISSION_TYPE.FLAT_PERCENT) body.flatPercent = Number(flatPercent);
      if (commissionType === COMMISSION_TYPE.FLAT_AMOUNT) body.flatPaise = String(Math.round(Number(flatRupees) * 100));
      if (commissionType === COMMISSION_TYPE.SLAB) {
        body.slabs = slabs.map((s) => ({
          seq: s.seq,
          fromPaise: s.fromPaise,
          toPaise: s.toPaise || undefined,
          ratePercent: s.ratePercent,
        }));
      }
      await createRuleMutation.mutateAsync(body);
      setShowRuleForm(false);
      refetchRules();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ── Commission payment lifecycle (keyboard-first: focused request input, Tab to Request, Enter submits) ──
  const [requestRupees, setRequestRupees] = useState('');
  const requestMutation = useApiMutation<unknown, Record<string, unknown>>('POST', '/commission-payments');
  const approveMutation = useApiMutation<unknown, { id: string }>('POST', (b) => `/commission-payments/${b.id}/approve`);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payMode, setPayMode] = useState('NEFT');
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  // Direct api() call, not useApiMutation: the pay() endpoint's body is
  // .strict() (payCommissionPaymentSchema) and must NOT include the payment
  // id (that's a URL param), whereas useApiMutation's generic body-becomes-
  // JSON-payload shape has no way to exclude a field used only for the URL.
  // pickForSchema projects onto payCommissionPaymentSchema's own declared
  // keys rather than hand-listing them, so this stays correct automatically
  // if the schema ever grows a field — the same helper used for the
  // UserForm/Masters update-payload bugs, applied here for consistency.

  async function handleRequest(e?: React.FormEvent) {
    e?.preventDefault();
    setError('');
    try {
      await requestMutation.mutateAsync({ brokerId, amountPaise: String(Math.round(Number(requestRupees) * 100)) });
      setRequestRupees('');
      refetchPayments();
      refetchBalance();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function handleApprove(id: string) {
    setError('');
    try {
      await approveMutation.mutateAsync({ id });
      refetchPayments();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function handlePay(id: string) {
    setError('');
    try {
      await api(`/commission-payments/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify(pickForSchema(payCommissionPaymentSchema, { mode: payMode, paymentDate: payDate })),
      });
      setPayingId(null);
      refetchPayments();
      refetchBalance();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ── Portal invite ──
  const [inviteChannel, setInviteChannel] = useState<'EMAIL' | 'SMS'>('EMAIL');
  const [inviteLink, setInviteLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [sendingInvite, setSendingInvite] = useState(false);

  async function sendPortalInvite() {
    setInviteError('');
    setInviteLink(null);
    setSendingInvite(true);
    try {
      const res = await api<{ inviteId: string; token: string; expiresAt: string }>('/admin/portal-invites', {
        method: 'POST',
        body: JSON.stringify({ brokerId, channel: inviteChannel }),
      });
      setInviteLink({
        url: `${window.location.origin}/portal/invite/${res.inviteId}?token=${res.token}`,
        expiresAt: res.expiresAt,
      });
    } catch (err) {
      setInviteError((err as Error).message);
    } finally {
      setSendingInvite(false);
    }
  }

  // ── Portal password reset ──
  const [resettingPortalPassword, setResettingPortalPassword] = useState(false);
  const [portalResetLink, setPortalResetLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [portalResetError, setPortalResetError] = useState('');
  const [portalNoAccount, setPortalNoAccount] = useState(false);

  async function resetPortalPassword() {
    setPortalResetError('');
    setPortalResetLink(null);
    setPortalNoAccount(false);
    setResettingPortalPassword(true);
    try {
      const res = await api<{ token: string; expiresAt: string }>('/admin/portal-password-resets', {
        method: 'POST',
        body: JSON.stringify({ brokerId }),
      });
      const parsed = forcePasswordResetResponseSchema.parse(res);
      setPortalResetLink({
        url: `${window.location.origin}/portal/reset-password?token=${parsed.token}`,
        expiresAt: parsed.expiresAt,
      });
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409 && apiErr.body?.code === NO_PORTAL_ACCOUNT_ERROR) {
        setPortalNoAccount(true);
      } else {
        setPortalResetError(apiErr.message);
      }
    } finally {
      setResettingPortalPassword(false);
    }
  }

  // ── Statement ──
  async function handleGenerateStatement() {
    setError('');
    try {
      const doc = await api<{ id: string; originalName: string }>(`/brokers/${brokerId}/documents/statement`, { method: 'POST' });
      await downloadFile(`/documents/${doc.id}/download`, doc.originalName);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!broker) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">{broker.name}</h1>
          <p className="text-sm text-slate-500">
            {broker.phone} {broker.email ? `· ${broker.email}` : ''} {broker.reraAgentNo ? `· RERA ${broker.reraAgentNo}` : ''}
          </p>
        </div>
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${broker.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
          {broker.isActive ? 'Active' : 'Inactive'}
        </span>
      </div>

      {canManagePortalAccess && (
        <div>
          <div className="flex items-center gap-2">
            <select value={inviteChannel} onChange={(e) => setInviteChannel(e.target.value as 'EMAIL' | 'SMS')} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </select>
            <button
              onClick={sendPortalInvite}
              disabled={sendingInvite}
              className="btn btn-secondary px-3 py-1.5 text-sm"
            >
              {sendingInvite ? 'Sending…' : 'Send Portal Invite'}
            </button>
            <button
              onClick={resetPortalPassword}
              disabled={resettingPortalPassword}
              className="btn btn-secondary px-3 py-1.5 text-sm"
            >
              {resettingPortalPassword ? 'Generating…' : 'Reset portal password'}
            </button>
          </div>
          <ResetLinkSupersedeNote />
          {inviteLink && (
            <RevealedResetLink url={inviteLink.url} expiresAt={inviteLink.expiresAt} onDismiss={() => setInviteLink(null)} />
          )}
          {inviteError && <p className="mt-1 text-xs text-red-600">{inviteError}</p>}
          {portalResetLink && (
            <RevealedResetLink url={portalResetLink.url} expiresAt={portalResetLink.expiresAt} onDismiss={() => setPortalResetLink(null)} />
          )}
          {portalNoAccount && (
            <p className="mt-1 text-xs text-slate-600">
              This person doesn&apos;t have a portal account yet — use Send Portal Invite above first.
            </p>
          )}
          {portalResetError && <p className="mt-1 text-xs text-red-600">{portalResetError}</p>}
        </div>
      )}
      {/* Its own gate, not inside the portal-access block above — see PortalTwoFactorReset. */}
      {hasPermission(PERMISSIONS.ADMIN_USER_UPDATE) && brokerId && (
        <PortalTwoFactorReset principal={{ brokerId }} name={broker.name} />
      )}

      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* PAN */}
      {canUpdateBroker && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-800">PAN</h2>
          <p className="mt-1 text-sm text-slate-600">
            {pan?.pan ? pan.pan : (broker.panMasked ?? 'Not on file')}
          </p>
          {broker.panMasked && !pan?.pan && (
            <button onClick={() => refetchPan()} className="mt-1 text-xs font-medium text-blue-600 hover:text-blue-800">
              Reveal (audited)
            </button>
          )}
        </section>
      )}

      {/* Bank details */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Bank Details</h2>
          <button onClick={() => setShowBankForm((s) => !s)} className="text-xs font-medium text-blue-600 hover:text-blue-800">
            {showBankForm ? 'Cancel' : 'Add'}
          </button>
        </div>
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {broker.bankDetails.map((bd) => (
            <li key={bd.id}>
              {bd.bankName} — {bd.accountHolder} — {bd.accountNumber} ({bd.ifsc}) {bd.isPrimary && <span className="text-xs text-blue-600">primary</span>}
            </li>
          ))}
          {broker.bankDetails.length === 0 && <li className="text-slate-400">No bank details yet</li>}
        </ul>
        {showBankForm && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <input tabIndex={1} autoFocus placeholder="Account holder" value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            <input tabIndex={2} placeholder="Account number" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            <input tabIndex={3} placeholder="IFSC" value={ifsc} onChange={(e) => setIfsc(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            <input tabIndex={4} placeholder="Bank name" value={bankName} onChange={(e) => setBankName(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
            <button tabIndex={5} onClick={handleAddBank} className="col-span-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
              Save Bank Detail
            </button>
          </div>
        )}
      </section>

      {/* Commission rules */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Commission Rules</h2>
          <button onClick={() => setShowRuleForm((s) => !s)} className="text-xs font-medium text-blue-600 hover:text-blue-800">
            {showRuleForm ? 'Cancel' : 'Add Rule'}
          </button>
        </div>

        <div className="mt-2 space-y-2">
          {rules?.map((r) => (
            <div key={r.id} className="rounded-md bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{r.commissionType}</span>
                <span className={`text-xs ${r.isActive ? 'text-emerald-600' : 'text-slate-400'}`}>{r.isActive ? 'Active' : 'Inactive'}</span>
              </div>
              {r.commissionType === COMMISSION_TYPE.FLAT_PERCENT && <p>{r.flatPercent}% of agreed price</p>}
              {r.commissionType === COMMISSION_TYPE.FLAT_AMOUNT && <p>{formatInr(BigInt(r.flatPaise ?? '0'))} flat</p>}
              {r.commissionType === COMMISSION_TYPE.SLAB && (
                <ul className="mt-1 space-y-0.5">
                  {r.slabs.map((s) => (
                    <li key={s.id}>
                      {formatInr(BigInt(s.fromPaise))} – {s.toPaise ? formatInr(BigInt(s.toPaise)) : '∞'}: {s.ratePercent}%
                    </li>
                  ))}
                </ul>
              )}
              {r.milestonesJson && r.milestonesJson.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">Milestones: {r.milestonesJson.join('%, ')}%</p>
              )}
            </div>
          ))}
          {rules && rules.length === 0 && <p className="text-sm text-slate-400">No commission rules yet — accrual will fail until one exists.</p>}
        </div>

        {showRuleForm && (
          <div className="mt-3 space-y-3 rounded-md bg-slate-50 p-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">Type</label>
              <select value={commissionType} onChange={(e) => setCommissionType(e.target.value)} className="mt-1 input px-2 py-1.5">
                <option value={COMMISSION_TYPE.FLAT_PERCENT}>Flat percent</option>
                <option value={COMMISSION_TYPE.FLAT_AMOUNT}>Flat amount</option>
                <option value={COMMISSION_TYPE.SLAB}>Slab</option>
              </select>
            </div>

            {commissionType === COMMISSION_TYPE.FLAT_PERCENT && (
              <div>
                <label className="block text-xs font-medium text-slate-700">Percent of agreed price</label>
                <input type="number" step="0.01" value={flatPercent} onChange={(e) => setFlatPercent(e.target.value)} className="mt-1 input px-2 py-1.5" />
              </div>
            )}
            {commissionType === COMMISSION_TYPE.FLAT_AMOUNT && (
              <div>
                <label className="block text-xs font-medium text-slate-700">Flat amount (₹)</label>
                <input type="number" value={flatRupees} onChange={(e) => setFlatRupees(e.target.value)} className="mt-1 input px-2 py-1.5" />
              </div>
            )}
            {commissionType === COMMISSION_TYPE.SLAB && (
              <div>
                <label className="block text-xs font-medium text-slate-700">Slabs (half-open [from, to)) — boundary matches the higher bracket</label>
                <div className="mt-1 space-y-1">
                  {slabs.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-6 text-xs text-slate-500">#{s.seq}</span>
                      <input type="number" placeholder="From ₹" value={Number(s.fromPaise) / 100} onChange={(e) => updateSlab(i, { fromPaise: String(Math.round(Number(e.target.value) * 100)) })} className="w-28 rounded-md border border-slate-300 px-2 py-1 text-sm" />
                      <input type="number" placeholder="To ₹ (blank = ∞)" value={s.toPaise ? Number(s.toPaise) / 100 : ''} onChange={(e) => updateSlab(i, { toPaise: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : undefined })} className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm" />
                      <input type="number" step="0.01" placeholder="Rate %" value={s.ratePercent} onChange={(e) => updateSlab(i, { ratePercent: Number(e.target.value) })} className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm" />
                      <button onClick={() => removeSlab(i)} className="text-xs text-red-600 hover:text-red-800">Remove</button>
                    </div>
                  ))}
                </div>
                <button onClick={addSlabRow} className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-800">Add slab</button>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700">Collection milestones (%, comma-separated — e.g. 25,50,100) — leave blank for ON_BOOKING mode</label>
              <input value={milestonesText} onChange={(e) => setMilestonesText(e.target.value)} className="mt-1 input px-2 py-1.5" />
            </div>

            <button onClick={handleCreateRule} className="btn btn-primary px-3 py-1.5 text-sm">
              Save Rule
            </button>
          </div>
        )}
      </section>

      {/* Commission balance + payments */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Commission</h2>
        <p className="mt-1 text-lg font-semibold text-slate-900">
          Outstanding: {balance ? formatInr(BigInt(balance.balancePaise)) : '—'}
        </p>

        {canCreatePayment && (
          <form onSubmit={handleRequest} className="mt-3 flex items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">Request payment (₹)</label>
              <input
                tabIndex={1}
                autoFocus
                type="number"
                value={requestRupees}
                onChange={(e) => setRequestRupees(e.target.value)}
                className="mt-1 w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </div>
            <button tabIndex={2} type="submit" disabled={!requestRupees} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              Request
            </button>
          </form>
        )}

        <div className="mt-4 space-y-2">
          {payments?.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-md bg-slate-50 p-2 text-sm">
              <span>
                {formatInr(BigInt(p.amountPaise))} — <span className="font-medium">{p.status}</span>
              </span>
              <div className="flex items-center gap-2">
                {p.status === 'REQUESTED' && canApprovePayment && (
                  <button onClick={() => handleApprove(p.id)} className="text-xs text-emerald-600 hover:text-emerald-800">Approve</button>
                )}
                {p.status === 'APPROVED' && canPayPayment && payingId !== p.id && (
                  <button onClick={() => setPayingId(p.id)} className="text-xs text-blue-600 hover:text-blue-800">Pay</button>
                )}
                {p.status === 'APPROVED' && payingId === p.id && (
                  <div className="flex items-center gap-1">
                    <select value={payMode} onChange={(e) => setPayMode(e.target.value)} className="rounded-md border border-slate-300 px-1 py-0.5 text-xs">
                      <option value="NEFT">NEFT</option>
                      <option value="RTGS">RTGS</option>
                      <option value="CHEQUE">CHEQUE</option>
                      <option value="CASH">CASH</option>
                    </select>
                    <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className="rounded-md border border-slate-300 px-1 py-0.5 text-xs" />
                    <button onClick={() => handlePay(p.id)} className="text-xs font-medium text-emerald-600 hover:text-emerald-800">Confirm</button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {payments && payments.length === 0 && <p className="text-sm text-slate-400">No payments yet</p>}
        </div>
      </section>

      {/* Statement */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Broker Statement</h2>
        <button onClick={handleGenerateStatement} className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
          Generate & Download PDF
        </button>
      </section>

      {/* Sold units */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">Sold Units</h2>
        <table className="mt-2 min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1">Booking</th>
              <th className="py-1">Applicant</th>
              <th className="py-1">Unit</th>
              <th className="py-1">Price</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {soldUnits?.map((row, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1">{row[1]}</td>
                <td className="py-1">{row[2]}</td>
                <td className="py-1">{row[3]}</td>
                <td className="py-1">{row[4]}</td>
                <td className="py-1">{row[5]}</td>
              </tr>
            ))}
            {soldUnits && soldUnits.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-slate-400">No units sold via this broker yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-slate-400">
        Cancellation of a booking sourced by this broker is blocked until a broker NOC is approved (requested/approved via the booking's cancel flow), or the broker is deactivated, which auto-approves it.
      </p>
    </div>
  );
}
