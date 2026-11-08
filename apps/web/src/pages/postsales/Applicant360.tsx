import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInr, forcePasswordResetResponseSchema, NO_PORTAL_ACCOUNT_ERROR, PERMISSIONS } from '@openestate/shared';
import { api, downloadFile, type ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import RevealedResetLink, { ResetLinkSupersedeNote } from '../../components/RevealedResetLink';
import PortalTwoFactorReset from '../../components/PortalTwoFactorReset';

interface Applicant {
  id: string;
  name: string;
  primaryPhone: string;
  email: string | null;
  city: string | null;
}

interface Booking {
  id: string;
  bookingNumber: string;
  status: string;
  agreedPricePaise: string;
  // floor is null for a LAND_BASED unit (Phase A) — every read must check
  // it, not assume it, per plotted-farmhouse-inventory.md §13.1.
  unit: { number: string; floor: { name: string; tower: { name: string } } | null };
}

interface FollowUp {
  id: string;
  notes: string | null;
  outcome: string | null;
  scheduledAt: string | null;
  createdAt: string;
}

interface Inquiry {
  id: string;
  status: string;
  createdAt: string;
  followUps: FollowUp[];
}

interface GeneratedDoc {
  id: string;
  documentType: string;
  originalName: string;
  isDuplicate: boolean;
  createdAt: string;
}

interface Dispatch {
  id: string;
  channel: string;
  recipientAddress: string;
  status: string;
  createdAt: string;
}

interface ThreeSixty {
  applicant: Applicant;
  bookings: Booking[];
  inquiries: Inquiry[];
  documents: GeneratedDoc[];
  dispatches: Dispatch[];
}

interface LedgerEntry {
  id: string;
  entryType: string;
  effectiveDate: string;
  reason: string | null;
  signedAmountPaise: string;
  runningBalancePaise: string;
}

interface LedgerReport {
  bookingNumber: string;
  entries: LedgerEntry[];
  balancePaise: string;
}

interface Installment {
  id: string;
  label: string;
  amountPaise: string;
  allocatedPaise: string;
  /** Null for an unraised STAGE_LINKED installment. */
  dueDate: string | null;
}

interface PlanVersion {
  id: string;
  isActive: boolean;
  installments: Installment[];
}

interface LetterTemplate {
  id: string;
  name: string;
  entityType: string;
}

export default function Applicant360() {
  const { applicantId } = useParams<{ applicantId: string }>();
  const { hasPermission } = useAuth();
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<ThreeSixty>({
    queryKey: ['applicant-360', applicantId],
    queryFn: () => api(`/applicants/${applicantId}/360`),
    enabled: !!applicantId,
  });

  const bookingId = selectedBookingId ?? data?.bookings?.[0]?.id ?? null;

  const { data: ledger } = useQuery<LedgerReport>({
    queryKey: ['applicant-ledger', bookingId],
    queryFn: () => api(`/reports/postsales/applicant-ledger/${bookingId}`),
    enabled: !!bookingId,
  });

  const { data: planVersions } = useQuery<PlanVersion[]>({
    queryKey: ['plan-history', bookingId],
    queryFn: () => api(`/bookings/${bookingId}/plan-history`),
    enabled: !!bookingId,
  });
  // Same allocation-time exclusion as ReceiptEntry.tsx's dueInstallments —
  // an unraised STAGE_LINKED installment (dueDate === null) has nothing
  // due to demand payment against, so it must not be offered as a demand/
  // reminder-letter target. See
  // internal plan construction-linked-demand-fix.md revision 2, clarification 1.
  const dueInstallments = (planVersions?.find((v) => v.isActive)?.installments ?? []).filter(
    (i) => i.dueDate !== null && BigInt(i.amountPaise) - BigInt(i.allocatedPaise) > 0n,
  );

  const { data: templatesRes } = useQuery<{ data: LetterTemplate[] }>({
    queryKey: ['letter-templates-all'],
    queryFn: () => api('/masters/letter-templates?limit=100'),
  });
  const templatesFor = (entityType: string) => templatesRes?.data?.filter((t) => t.entityType === entityType) ?? [];

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
        body: JSON.stringify({ applicantId, channel: inviteChannel }),
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
        body: JSON.stringify({ applicantId }),
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

  const qc = useQueryClient();
  const [allotmentTemplateId, setAllotmentTemplateId] = useState('');
  const [demandTemplateId, setDemandTemplateId] = useState('');
  const [demandInstallmentId, setDemandInstallmentId] = useState('');
  const [reminderTemplateId, setReminderTemplateId] = useState('');
  const [reminderInstallmentId, setReminderInstallmentId] = useState('');
  const [genError, setGenError] = useState('');
  const [generating, setGenerating] = useState<string | null>(null);

  async function generate(kind: 'statement' | 'allotment-letter' | 'demand-letter' | 'reminder-letter', body?: Record<string, string>) {
    if (!bookingId) return;
    setGenError('');
    setGenerating(kind);
    try {
      const doc = await api<{ id: string; originalName: string }>(`/bookings/${bookingId}/documents/${kind}`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      });
      await downloadFile(`/documents/${doc.id}/download`, doc.originalName);
      qc.invalidateQueries({ queryKey: ['applicant-360', applicantId] });
    } catch (err) {
      setGenError((err as Error).message);
    } finally {
      setGenerating(null);
    }
  }

  if (isLoading || !data) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }

  const { applicant, bookings, inquiries, documents, dispatches } = data;

  return (
    <div>
      <h1 className="page-title">{applicant.name}</h1>
      <div className="mt-1 flex gap-4 text-sm text-slate-600">
        <span>{applicant.primaryPhone}</span>
        {applicant.email && <span>{applicant.email}</span>}
        {applicant.city && <span>{applicant.city}</span>}
      </div>

      {hasPermission(PERMISSIONS.ADMIN_PORTAL_INVITE_SEND) && (
        <div className="mt-3">
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
      {/* Its own gate, not inside the invite block above — see PortalTwoFactorReset. */}
      {hasPermission(PERMISSIONS.ADMIN_USER_UPDATE) && applicantId && (
        <PortalTwoFactorReset principal={{ applicantId }} name={applicant.name} />
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Bookings</h2>
          <ul className="mt-2 space-y-1">
            {bookings.length === 0 && <li className="text-xs text-slate-500">No bookings.</li>}
            {bookings.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => setSelectedBookingId(b.id)}
                  className={`block w-full rounded-md px-3 py-2 text-left text-sm ${
                    bookingId === b.id ? 'bg-blue-50 text-blue-900' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="font-medium">{b.bookingNumber} — {b.status}</div>
                  <div className="text-xs text-slate-500">
                    {b.unit.floor ? `${b.unit.floor.tower.name}/${b.unit.floor.name}/` : ''}{b.unit.number} · {formatInr(BigInt(b.agreedPricePaise))}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">
            Ledger {ledger && `— ${ledger.bookingNumber} (balance ${formatInr(BigInt(ledger.balancePaise))})`}
          </h2>
          <div className="mt-2 max-h-64 overflow-y-auto">
            {!ledger || ledger.entries.length === 0 ? (
              <p className="text-xs text-slate-500">No ledger entries.</p>
            ) : (
              <table className="min-w-full text-xs">
                <tbody className="divide-y divide-slate-100">
                  {ledger.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="py-1 pr-2 text-slate-500">{e.effectiveDate}</td>
                      <td className="py-1 pr-2 font-medium text-slate-700">{e.entryType}</td>
                      <td className="py-1 pr-2 text-slate-500">{e.reason ?? ''}</td>
                      <td className={`py-1 text-right ${BigInt(e.signedAmountPaise) < 0n ? 'text-emerald-600' : 'text-slate-700'}`}>
                        {formatInr(BigInt(e.signedAmountPaise))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Generate documents</h2>
          {!bookingId ? (
            <p className="mt-2 text-xs text-slate-500">No booking selected.</p>
          ) : (
            <div className="mt-2 space-y-3">
              <button
                onClick={() => generate('statement')}
                disabled={generating === 'statement'}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {generating === 'statement' ? 'Generating…' : 'Generate Statement'}
              </button>

              <div className="flex items-center gap-2">
                <select value={allotmentTemplateId} onChange={(e) => setAllotmentTemplateId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
                  <option value="">Allotment letter template…</option>
                  {templatesFor('ALLOTMENT_LETTER').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button
                  onClick={() => generate('allotment-letter', { templateId: allotmentTemplateId })}
                  disabled={!allotmentTemplateId || generating === 'allotment-letter'}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {generating === 'allotment-letter' ? 'Generating…' : 'Generate'}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <select value={demandTemplateId} onChange={(e) => setDemandTemplateId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
                  <option value="">Demand letter template…</option>
                  {templatesFor('DEMAND_LETTER').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select value={demandInstallmentId} onChange={(e) => setDemandInstallmentId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
                  <option value="">Due installment…</option>
                  {dueInstallments.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                </select>
                <button
                  onClick={() => generate('demand-letter', { templateId: demandTemplateId, installmentId: demandInstallmentId })}
                  disabled={!demandTemplateId || !demandInstallmentId || generating === 'demand-letter'}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {generating === 'demand-letter' ? 'Generating…' : 'Generate'}
                </button>
              </div>

              <div className="flex items-center gap-2">
                <select value={reminderTemplateId} onChange={(e) => setReminderTemplateId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
                  <option value="">Reminder letter template…</option>
                  {templatesFor('REMINDER_LETTER').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select value={reminderInstallmentId} onChange={(e) => setReminderInstallmentId(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-xs">
                  <option value="">Due installment…</option>
                  {dueInstallments.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                </select>
                <button
                  onClick={() => generate('reminder-letter', { templateId: reminderTemplateId, installmentId: reminderInstallmentId })}
                  disabled={!reminderTemplateId || !reminderInstallmentId || generating === 'reminder-letter'}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {generating === 'reminder-letter' ? 'Generating…' : 'Generate'}
                </button>
              </div>

              {genError && <p className="text-xs text-red-600">{genError}</p>}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Follow-up & inquiry timeline</h2>
          <ul className="mt-2 space-y-3">
            {inquiries.length === 0 && <li className="text-xs text-slate-500">No inquiries.</li>}
            {inquiries.map((inq) => (
              <li key={inq.id}>
                <div className="text-xs font-medium text-slate-700">
                  Inquiry — {inq.status} ({new Date(inq.createdAt).toLocaleDateString('en-IN')})
                </div>
                <ul className="ml-3 mt-1 space-y-1 border-l border-slate-200 pl-3">
                  {inq.followUps.map((f) => (
                    <li key={f.id} className="text-xs text-slate-500">
                      {new Date(f.createdAt).toLocaleDateString('en-IN')} — {f.outcome ?? 'pending'} {f.notes && `— ${f.notes}`}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Documents & dispatch history</h2>
          <ul className="mt-2 space-y-1">
            {documents.length === 0 && <li className="text-xs text-slate-500">No generated documents.</li>}
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between text-xs">
                <span>
                  {d.documentType} {d.isDuplicate && <span className="text-red-600">(DUPLICATE)</span>} — {new Date(d.createdAt).toLocaleDateString('en-IN')}
                </span>
                <button
                  onClick={() => downloadFile(`/documents/${d.id}/download`, d.originalName)}
                  className="font-medium text-blue-600 hover:text-blue-800"
                >
                  Download
                </button>
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-xs font-semibold text-slate-700">Dispatch history</h3>
          <ul className="mt-1 space-y-1">
            {dispatches.length === 0 && <li className="text-xs text-slate-500">No dispatches.</li>}
            {dispatches.map((d) => (
              <li key={d.id} className="text-xs text-slate-500">
                {d.channel} to {d.recipientAddress} — {d.status} ({new Date(d.createdAt).toLocaleDateString('en-IN')})
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
