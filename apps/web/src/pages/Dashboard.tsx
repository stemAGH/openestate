import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatDate, INQUIRY_STATUS_LABELS, PERMISSIONS, type InquiryStatusValue } from '@openestate/shared';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import DataTable, { type Column } from '../components/DataTable';
import { Badge, ContactActions, FollowUpDue, PageHeader } from '../ui';

interface MyDayInquiry {
  id: string;
  nextFollowupAt: string | null;
  applicant: { name: string; primaryPhone: string };
  project: { name: string } | null;
}

interface StatusCount {
  status: string;
  count: number;
}

interface Summary {
  followUpsToday: number;
  followUpsOverdue: number;
  openInquiries: number;
  conversionsThisMonth: number;
  byStatus: StatusCount[];
}

interface ReportRow {
  userId: string;
  name: string;
  roleName: string | null;
  openInquiries: number;
  followUpsToday: number;
  followUpsOverdue: number;
  conversionsThisMonth: number;
  lastActivityAt: string | null;
}

interface DashboardData {
  mine: Summary;
  team: (Summary & { memberCount: number; perReport: ReportRow[] }) | null;
  generatedAt: string;
}

/** DataTable keys rows off `id`; the API calls it `userId` (clearer there). */
type ReportRowWithId = ReportRow & { id: string };

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / 86_400_000);
}

function activityLabel(iso: string | null): string {
  const days = daysSince(iso);
  if (days === null) return 'No activity logged';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

function Stat({
  label,
  value,
  tone = 'default',
  to,
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warn';
  to?: string;
}) {
  const body = (
    <div
      className={`h-full rounded-lg border p-3 shadow-sm sm:p-4 ${
        tone === 'warn' && value > 0 ? 'border-amber-200 bg-amber-50' : 'border-line bg-surface'
      }`}
    >
      <div className="text-xs font-medium text-fg-2 sm:text-sm">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'warn' && value > 0 ? 'text-amber-800' : 'text-fg'
        }`}
      >
        {value}
      </div>
    </div>
  );
  return to ? (
    <Link to={to} className="block rounded-lg hover:shadow-lg">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Each tile opens the inquiry list filtered to exactly what it counts. `ownerId` narrows "My work" to the user's own leads. */
function SummaryBlock({ summary, ownerId }: { summary: Summary; ownerId?: string }) {
  const nonZeroStatuses = summary.byStatus.filter((s) => s.count > 0);
  const list = (q: string) => `/presales/inquiries?${q}${ownerId ? `&assignedToId=${ownerId}` : ''}`;
  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Follow-ups due today" value={summary.followUpsToday} to={list('followUp=today')} />
        <Stat label="Overdue follow-ups" value={summary.followUpsOverdue} tone="warn" to={list('followUp=overdue')} />
        <Stat label="Open inquiries" value={summary.openInquiries} to={list('status=OPEN,CONTINUED')} />
        <Stat label="Converted this month" value={summary.conversionsThisMonth} />
      </div>
      {nonZeroStatuses.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-2">
          <span>By status:</span>
          {nonZeroStatuses.map((s) => (
            <Badge key={s.status}>
              {INQUIRY_STATUS_LABELS[s.status as InquiryStatusValue] ?? s.status} {s.count}
            </Badge>
          ))}
        </div>
      )}
    </>
  );
}

/** "Good morning" by the IST clock, whatever the browser's time zone. */
function greeting(now: Date): string {
  const istHour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
  return istHour < 12 ? 'Good morning' : istHour < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const { data, isLoading, isError } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api('/dashboard'),
    retry: false,
  });
  // The greeting uses the person's name (the token only carries the email).
  // Its own cache key, never Settings' ['auth', 'me']: sharing that entry let
  // Settings show a cached copy after the server had ended the session, so
  // the 401 that signs the user out never happened. Like every key, this one
  // is dropped with the session's QueryClient (main.tsx, keyed by sessionEpoch).
  const { data: me } = useQuery<{ name: string }>({
    queryKey: ['dashboard', 'greeting-name'],
    queryFn: () => api('/auth/me'),
  });

  // GET /inquiries/my-day has existed since v0.4 (today's + overdue
  // follow-ups assigned to the caller) with no frontend caller until now
  // — same endpoint the dashboard's own "due today"/"overdue" counts
  // above summarize, just the actual rows instead of a count.
  const { data: myDay } = useQuery<MyDayInquiry[]>({
    queryKey: ['my-day'],
    queryFn: () => api('/inquiries/my-day'),
    retry: false,
  });

  const perReportRows: ReportRowWithId[] = (data?.team?.perReport ?? []).map((r) => ({
    ...r,
    id: r.userId,
  }));

  const columns: Column<ReportRowWithId>[] = [
    { key: 'name', header: 'Name', render: (r) => r.name },
    { key: 'role', header: 'Role', render: (r) => r.roleName ?? '—' },
    { key: 'open', header: 'Open', render: (r) => r.openInquiries },
    { key: 'today', header: 'Due today', render: (r) => r.followUpsToday },
    {
      key: 'overdue',
      header: 'Overdue',
      render: (r) => (
        <span className={r.followUpsOverdue > 0 ? 'font-medium text-amber-700' : ''}>
          {r.followUpsOverdue}
        </span>
      ),
    },
    { key: 'converted', header: 'Converted this month', render: (r) => r.conversionsThisMonth },
    {
      key: 'activity',
      header: 'Last activity',
      render: (r) => {
        const days = daysSince(r.lastActivityAt);
        const stale = days === null || days >= 7;
        return (
          <span className={stale ? 'font-medium text-amber-700' : 'text-slate-600'}>
            {activityLabel(r.lastActivityAt)}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={`${greeting(new Date())}, ${me?.name ?? user?.email ?? ''} · ${formatDate(new Date())}`}
      />

      {isError && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          Your role doesn't have access to pre-sales data, so there's no work summary to show here.
          Use the sidebar to reach the areas you do have access to.
        </div>
      )}

      {isLoading && <p className="mt-6 text-sm text-slate-500">Loading…</p>}

      {data && (
        <>
          <section className="mt-6">
            <h2 className="section-title">My work</h2>
            <SummaryBlock summary={data.mine} ownerId={user?.sub} />
          </section>

          <section className="mt-8" data-testid="my-day">
            <h2 className="section-title">My day</h2>
            <p className="mt-1 text-xs text-slate-500">
              Leads assigned to you that are due today or overdue, oldest due date first.
            </p>
            <ul className="mt-3 space-y-2">
              {(myDay ?? []).length === 0 ? (
                <li className="text-sm text-slate-500">Nothing due — you're caught up.</li>
              ) : (
                myDay!.map((inq) => (
                  <li key={inq.id} className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                    <div className="min-w-0">
                      <Link to={`/presales/inquiries/${inq.id}`} className="font-medium text-primary hover:underline">
                        {inq.applicant.name}
                      </Link>
                      {inq.project && <span className="text-fg-2"> · {inq.project.name}</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      <FollowUpDue at={inq.nextFollowupAt} />
                      <ContactActions name={inq.applicant.name} phone={inq.applicant.primaryPhone} />
                    </div>
                  </li>
                ))
              )}
            </ul>
          </section>

          {data.team && (
            <>
              <section className="mt-8">
                <h2 className="section-title">
                  My team ({data.team.memberCount}{' '}
                  {data.team.memberCount === 1 ? 'person' : 'people'}, including me)
                </h2>
                <SummaryBlock summary={data.team} />
              </section>

              <section className="mt-8">
                <h2 className="section-title">
                  Per report
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Everyone in your reporting line except you. "Last activity" is the most recent
                  follow-up they logged.
                </p>
                <div className="mt-3">
                  <DataTable columns={columns} data={perReportRows} isLoading={false} />
                </div>
              </section>
            </>
          )}

          {!data.team && (
            <p className="mt-8 text-sm text-slate-500">
              You have no reports configured, so there's no team view.
              {/* Only offered to someone who can actually open it —
                  sales_executive holds no ADMIN_USER_READ, and a link
                  straight into a 403 is worse than no link. */}
              {hasPermission(PERMISSIONS.ADMIN_USER_READ) && (
                <>
                  {' '}
                  <Link to="/admin/hierarchy" className="font-medium text-blue-600 hover:underline">
                    View the reporting hierarchy
                  </Link>{' '}
                  to see how your organisation is set up.
                </>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
