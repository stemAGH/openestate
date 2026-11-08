import { INQUIRY_STATUS_LABELS, type InquiryStatusValue } from '@openestate/shared';
import { Badge, type BadgeTone } from './Badge';

const STATUS_TONES: Record<InquiryStatusValue, BadgeTone> = {
  OPEN: 'info',
  CONTINUED: 'primary',
  DUMPED: 'neutral',
  SUCCESSFUL: 'success',
};

export function InquiryStatusBadge({ status }: { status: string }) {
  const s = status as InquiryStatusValue;
  return <Badge tone={STATUS_TONES[s] ?? 'neutral'}>{INQUIRY_STATUS_LABELS[s] ?? status}</Badge>;
}

/** Temperature names come from the master table; Hot/Warm/Cold get their colours, anything else stays neutral. */
export function TemperatureBadge({ name }: { name: string | null | undefined }) {
  if (!name) return <span className="text-fg-2">—</span>;
  const n = name.toLowerCase();
  if (n.includes('hot')) return <Badge className="bg-orange-50 text-orange-700">{name}</Badge>;
  if (n.includes('warm')) return <Badge tone="warning">{name}</Badge>;
  if (n.includes('cold')) return <Badge tone="info">{name}</Badge>;
  return <Badge>{name}</Badge>;
}
