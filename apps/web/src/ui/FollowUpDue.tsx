import { formatDate, followUpDueLabel } from '@openestate/shared';

/** "Today" / "2 days overdue" (orange when due or late) with the DD-MM-YYYY date underneath. */
export function FollowUpDue({ at, now = new Date() }: { at: string | null | undefined; now?: Date }) {
  if (!at) return <span className="text-fg-2">—</span>;
  const { label, overdue } = followUpDueLabel(at, now);
  const urgent = overdue || label === 'Today';
  return (
    <span className="flex flex-col leading-tight">
      <span className={urgent ? 'font-medium text-orange-700' : 'text-fg'}>{label}</span>
      <span className="text-xs text-fg-2">{formatDate(at)}</span>
    </span>
  );
}
