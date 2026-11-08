import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, INQUIRY_STATUS_LABELS, PERMISSIONS, type InquiryStatusValue } from '@openestate/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Card, ContactActions, EmptyState, FollowUpDue, InquiryStatusBadge, PageHeader } from '../../ui';
import {
  CustomFieldDisplay,
  useCustomFieldDefinitions,
} from '../../components/CustomFieldInputs';

interface Inquiry {
  id: string;
  status: string;
  stageId: string | null;
  applicant: {
    id: string;
    name: string;
    primaryPhone: string;
    customFields?: Record<string, unknown> | null;
  };
  project: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  nextFollowupAt: string | null;
  customFields?: Record<string, unknown> | null;
}

interface FollowUp {
  id: string;
  notes: string | null;
  outcome: string | null;
  scheduledAt: string | null;
  venue: string | null;
  interactionAt: string;
  nextActionAt: string | null;
  createdAt: string;
  type: { name: string } | null;
  createdBy: { id: string; name: string } | null;
}

/** `datetime-local` inputs want "YYYY-MM-DDTHH:mm" in the browser's own
 *  timezone, not an ISO string — this is the one conversion every field
 *  in this form needs, so it's shared rather than repeated per field. */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface MasterOption {
  id: string;
  name: string;
}

interface UserOption {
  id: string;
  name: string;
}

const STATUSES = Object.keys(INQUIRY_STATUS_LABELS) as InquiryStatusValue[];

export default function InquiryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();

  const [typeId, setTypeId] = useState('');
  const [notes, setNotes] = useState('');
  const [interactionAt, setInteractionAt] = useState(() => toDatetimeLocalValue(new Date()));
  const [nextActionAt, setNextActionAt] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [venue, setVenue] = useState('');
  const [followUpError, setFollowUpError] = useState('');

  const { definitions: inquiryDefs } = useCustomFieldDefinitions('INQUIRY');
  const { definitions: applicantDefs } = useCustomFieldDefinitions('APPLICANT');

  const [toUserId, setToUserId] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [assignError, setAssignError] = useState('');

  const [statusError, setStatusError] = useState('');
  const [stageError, setStageError] = useState('');

  const [showDumpForm, setShowDumpForm] = useState(false);
  const [dumpReasonId, setDumpReasonId] = useState('');
  const [dumpRemarks, setDumpRemarks] = useState('');
  const [dumpError, setDumpError] = useState('');

  const { data: inquiry } = useQuery<Inquiry>({
    queryKey: ['inquiry', id],
    queryFn: () => api(`/inquiries/${id}`),
    enabled: !!id,
  });

  const { data: followUps } = useQuery<FollowUp[]>({
    queryKey: ['follow-ups', id],
    queryFn: () => api(`/inquiries/${id}/follow-ups`),
    enabled: !!id,
  });

  const { data: followUpTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'follow-up-types', 'all'],
    queryFn: () => api('/masters/follow-up-types?limit=100'),
  });

  // Reassigning needs presales.inquiry.assign, and its user list needs
  // admin.user.read: without both, neither the form nor the request
  // (previously a silent 403 for sales executives) is shown.
  const canReassign =
    hasPermission(PERMISSIONS.PRESALES_INQUIRY_ASSIGN) && hasPermission(PERMISSIONS.ADMIN_USER_READ);
  const { data: users } = useQuery<{ data: UserOption[] }>({
    queryKey: ['users', 'all'],
    queryFn: () => api('/users?page=1&limit=100'),
    enabled: canReassign,
  });

  const { data: leadStages } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'lead-stages', 'all'],
    queryFn: () => api('/masters/lead-stages?limit=100'),
  });

  const { data: dumpReasons } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'dump-reasons', 'all'],
    queryFn: () => api('/masters/dump-reasons?limit=100'),
  });

  const handleAddFollowUp = async () => {
    setFollowUpError('');
    try {
      await api(`/inquiries/${id}/follow-ups`, {
        method: 'POST',
        body: JSON.stringify({
          typeId: typeId === '' ? undefined : typeId,
          notes: notes.trim() === '' ? undefined : notes.trim(),
          interactionAt: interactionAt === '' ? undefined : interactionAt,
          nextActionAt: nextActionAt === '' ? undefined : nextActionAt,
          scheduledAt: scheduledAt === '' ? undefined : scheduledAt,
          venue: venue.trim() === '' ? undefined : venue.trim(),
        }),
      });
      qc.invalidateQueries({ queryKey: ['follow-ups', id] });
      qc.invalidateQueries({ queryKey: ['inquiry', id] });
      setTypeId('');
      setNotes('');
      setInteractionAt(toDatetimeLocalValue(new Date()));
      setNextActionAt('');
      setScheduledAt('');
      setVenue('');
    } catch (err) {
      setFollowUpError((err as Error).message);
    }
  };

  const handleReassign = async () => {
    setAssignError('');
    try {
      await api(`/inquiries/${id}/assign`, {
        method: 'PATCH',
        body: JSON.stringify({ toUserId, reason: assignReason.trim() === '' ? undefined : assignReason.trim() }),
      });
      qc.invalidateQueries({ queryKey: ['inquiry', id] });
      setToUserId('');
      setAssignReason('');
    } catch (err) {
      setAssignError((err as Error).message);
    }
  };

  const handleStatusChange = async (status: string) => {
    // Dump is special-cased below (SOP rule 5: requires a reason and
    // remarks) — this handler stays for the other three, which have no
    // such requirement.
    if (status === 'DUMPED') {
      setDumpError('');
      setShowDumpForm(true);
      return;
    }
    setStatusError('');
    try {
      await api(`/inquiries/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      qc.invalidateQueries({ queryKey: ['inquiry', id] });
    } catch (err) {
      setStatusError((err as Error).message);
    }
  };

  const handleDump = async () => {
    setDumpError('');
    try {
      await api(`/inquiries/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'DUMPED', dumpReasonId, dumpRemarks }),
      });
      qc.invalidateQueries({ queryKey: ['inquiry', id] });
      setShowDumpForm(false);
      setDumpReasonId('');
      setDumpRemarks('');
    } catch (err) {
      setDumpError((err as Error).message);
    }
  };

  const handleStageChange = async (stageId: string) => {
    // "No stage" (value="") only ever reflects an inquiry that has no
    // stage yet — it isn't a selectable target. updateInquirySchema's
    // stageId is deliberately never nullable (a lead's stage is only
    // ever moved, never cleared once set — see LeadStage's own doc
    // comment), so submitting an empty string would just 400.
    if (stageId === '') return;
    setStageError('');
    try {
      await api(`/inquiries/${id}`, { method: 'PATCH', body: JSON.stringify({ stageId }) });
      qc.invalidateQueries({ queryKey: ['inquiry', id] });
    } catch (err) {
      setStageError((err as Error).message);
    }
  };

  if (!inquiry) return <div className="text-fg-2">Loading…</div>;

  const isActive = inquiry.status === 'OPEN' || inquiry.status === 'CONTINUED';
  const history = [...(followUps ?? [])].sort(
    (a, b) => new Date(b.interactionAt).getTime() - new Date(a.interactionAt).getTime(),
  );

  return (
    <div>
      <PageHeader
        title={inquiry.applicant.name}
        description={
          <>
            {inquiry.applicant.primaryPhone}
            {inquiry.project && <> · {inquiry.project.name}</>}
            {inquiry.assignedTo && <> · Owner: {inquiry.assignedTo.name}</>}
          </>
        }
        actions={<ContactActions name={inquiry.applicant.name} phone={inquiry.applicant.primaryPhone} />}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Right column on desktop, first on phones: logging a follow-up is the most frequent action. */}
        <div className="order-first space-y-6 lg:order-last lg:col-span-1">
          <Card className="p-4 lg:sticky lg:top-4">
            <h2 className="section-title">Log follow-up</h2>
            <p className="mt-1 text-xs text-fg-2">
              To log a site visit, pick the &quot;Site Visit&quot; type and fill in the date and venue.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3">
              <div>
                <label htmlFor="fu-type" className="block text-sm font-medium text-slate-700">Type</label>
                <select id="fu-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} className="mt-1 input">
                  <option value="">Select…</option>
                  {followUpTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="fu-notes" className="block text-sm font-medium text-slate-700">Notes</label>
                <textarea id="fu-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="mt-1 input" />
              </div>
              <div>
                <label htmlFor="fu-interaction" className="block text-sm font-medium text-slate-700">Interaction happened at</label>
                <input id="fu-interaction" type="datetime-local" value={interactionAt} onChange={(e) => setInteractionAt(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label htmlFor="fu-next" className="block text-sm font-medium text-slate-700">
                  Next follow-up{isActive && <span className="text-red-600"> *</span>}
                </label>
                <input id="fu-next" type="datetime-local" value={nextActionAt} onChange={(e) => setNextActionAt(e.target.value)} className="mt-1 input" />
                {isActive && (
                  <p className="mt-1 text-xs text-slate-500">Required while this lead is active — it won&apos;t be visible in My Day otherwise.</p>
                )}
              </div>
              <div>
                <label htmlFor="fu-scheduled" className="block text-sm font-medium text-slate-700">Scheduled At (for site visits)</label>
                <input id="fu-scheduled" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label htmlFor="fu-venue" className="block text-sm font-medium text-slate-700">Venue</label>
                <input id="fu-venue" type="text" value={venue} onChange={(e) => setVenue(e.target.value)} className="mt-1 input" />
              </div>
            </div>
            <div className="mt-3">
              <button onClick={handleAddFollowUp} className="btn btn-md btn-primary w-full sm:w-auto">
                Log Follow-up
              </button>
            </div>
            {followUpError && <p className="mt-2 text-sm text-red-600">{followUpError}</p>}
          </Card>

          {canReassign && (
            <Card className="p-4">
              <h2 className="section-title">Reassign</h2>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <div>
                  <label htmlFor="assign-to" className="block text-sm font-medium text-slate-700">Assign To</label>
                  <select id="assign-to" value={toUserId} onChange={(e) => setToUserId(e.target.value)} className="mt-1 input">
                    <option value="">Select…</option>
                    {users?.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="assign-reason" className="block text-sm font-medium text-slate-700">Reason</label>
                  <input id="assign-reason" type="text" value={assignReason} onChange={(e) => setAssignReason(e.target.value)} className="mt-1 input" />
                </div>
              </div>
              <button onClick={handleReassign} disabled={!toUserId} className="btn btn-md btn-secondary mt-3">
                Reassign
              </button>
              {assignError && <p className="mt-2 text-sm text-red-600">{assignError}</p>}
            </Card>
          )}
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="section-title">Status</h2>
              <span data-testid="inquiry-status">
                <InquiryStatusBadge status={inquiry.status} />
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {STATUSES.filter((s) => s !== inquiry.status).map((s) => (
                <button key={s} onClick={() => handleStatusChange(s)} className="btn btn-sm btn-secondary">
                  Mark as {INQUIRY_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            {statusError && <p className="mt-2 text-sm text-red-600">{statusError}</p>}

            {inquiry.status === 'SUCCESSFUL' && hasPermission('postsales.booking.create') && (
              <Link
                to={`/postsales/bookings/new?sourceInquiryId=${inquiry.id}&applicantId=${inquiry.applicant.id}${inquiry.project ? `&projectId=${inquiry.project.id}` : ''}`}
                className="btn btn-md btn-primary mt-3"
              >
                Create Booking
              </Link>
            )}

            {showDumpForm && (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4" data-testid="dump-form">
                <p className="text-sm text-amber-900">Dumping a lead requires a reason and remarks, for future reference.</p>
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="dump-reason" className="block text-sm font-medium text-slate-700">Reason</label>
                    <select id="dump-reason" value={dumpReasonId} onChange={(e) => setDumpReasonId(e.target.value)} className="mt-1 input">
                      <option value="">Select…</option>
                      {dumpReasons?.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="dump-remarks" className="block text-sm font-medium text-slate-700">Remarks</label>
                    <input id="dump-remarks" type="text" value={dumpRemarks} onChange={(e) => setDumpRemarks(e.target.value)} className="mt-1 input" />
                  </div>
                </div>
                <div className="mt-3 flex gap-3">
                  <button onClick={handleDump} disabled={!dumpReasonId || !dumpRemarks.trim()} className="btn btn-md btn-warning">
                    Confirm Dump
                  </button>
                  <button onClick={() => setShowDumpForm(false)} className="btn btn-md btn-secondary">Cancel</button>
                </div>
                {dumpError && <p className="mt-2 text-sm text-red-600">{dumpError}</p>}
              </div>
            )}

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="inquiry-stage" className="block text-sm font-medium text-slate-700">Stage</label>
                <select id="inquiry-stage" value={inquiry.stageId ?? ''} onChange={(e) => handleStageChange(e.target.value)} className="mt-1 input">
                  <option value="">No stage</option>
                  {leadStages?.data?.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {stageError && <p className="mt-2 text-sm text-red-600">{stageError}</p>}
              </div>
              <div>
                <p className="text-sm font-medium text-slate-700">Next follow-up</p>
                <div className="mt-2 text-sm">
                  <FollowUpDue at={isActive ? inquiry.nextFollowupAt : null} />
                </div>
              </div>
            </div>

            <div className="mt-4" data-testid="inquiry-custom-field-display">
              <CustomFieldDisplay definitions={inquiryDefs} values={inquiry.customFields} />
              <CustomFieldDisplay definitions={applicantDefs} values={inquiry.applicant.customFields} />
            </div>
          </Card>

          <section>
            <h2 className="section-title">History</h2>
            {history.length === 0 ? (
              <Card className="mt-3">
                <EmptyState message="No follow-ups yet. Log the first one to start this lead's history." />
              </Card>
            ) : (
              <ol className="mt-3 space-y-2">
                {history.map((f) => (
                  <li key={f.id} className="card p-3 text-sm">
                    <div className="font-medium text-fg">
                      {f.type?.name ?? 'Follow-up'} · {formatDateTime(f.interactionAt)}
                      {f.createdBy && <span className="font-normal text-fg-2"> by {f.createdBy.name}</span>}
                    </div>
                    {f.notes && <div className="mt-1 text-fg">{f.notes}</div>}
                    {f.nextActionAt && <div className="mt-1 text-fg-2">Next follow-up: {formatDateTime(f.nextActionAt)}</div>}
                    {f.scheduledAt && (
                      <div className="text-fg-2">
                        Site visit: {formatDateTime(f.scheduledAt)} {f.venue && `at ${f.venue}`}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
