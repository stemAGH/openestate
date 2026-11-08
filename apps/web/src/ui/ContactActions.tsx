import { MessageCircle, Phone } from 'lucide-react';
import { whatsAppNumber } from '@openestate/shared';
import { api } from '../lib/api';
import { toast } from '../lib/toast';

const ICON =
  'inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-2 hover:bg-surface-muted hover:text-fg';

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

/** Follows a link in this tab, the way clicking it would. */
function followLink(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.click();
}

type Props =
  /** A detail view: the full number is already on the page. */
  | { name: string; phone: string | null | undefined; inquiryId?: never }
  /**
   * A list view: lists only carry the last 4 digits, so the full number is
   * fetched from the inquiry's detail endpoint (same permission and team
   * scope) when a button is pressed.
   */
  | { name: string; inquiryId: string; phone?: never };

/** Call (tel:) and WhatsApp (wa.me) for one person, each named with who it reaches ("Call Priya Sharma"). */
export function ContactActions(props: Props) {
  const { name } = props;

  if (props.inquiryId === undefined) {
    const phone = props.phone;
    if (!phone) return null;
    const wa = whatsAppNumber(phone);
    return (
      <span className="inline-flex items-center gap-1">
        <a href={telHref(phone)} aria-label={`Call ${name}`} title={`Call ${name}`} className={ICON}>
          <Phone size={18} aria-hidden="true" />
        </a>
        {wa && (
          <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${name}`} title={`WhatsApp ${name}`} className={ICON}>
            <MessageCircle size={18} aria-hidden="true" />
          </a>
        )}
      </span>
    );
  }

  const inquiryId = props.inquiryId;
  const fetchPhone = async () =>
    (await api<{ applicant: { primaryPhone: string } }>(`/inquiries/${inquiryId}`)).applicant.primaryPhone;

  const call = async () => {
    try {
      followLink(telHref(await fetchPhone()));
    } catch {
      toast.error(`Couldn't get ${name}'s number.`);
    }
  };

  const whatsApp = async () => {
    // Opened now, while the click still counts as the user's: a tab opened
    // after the request returns would be blocked as a pop-up.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const wa = whatsAppNumber(await fetchPhone());
      if (!wa) {
        tab?.close();
        toast.error(`${name} has no WhatsApp-capable number on file.`);
        return;
      }
      if (tab) tab.location.href = `https://wa.me/${wa}`;
    } catch {
      tab?.close();
      toast.error(`Couldn't get ${name}'s number.`);
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" onClick={call} aria-label={`Call ${name}`} title={`Call ${name}`} className={ICON}>
        <Phone size={18} aria-hidden="true" />
      </button>
      <button type="button" onClick={whatsApp} aria-label={`WhatsApp ${name}`} title={`WhatsApp ${name}`} className={ICON}>
        <MessageCircle size={18} aria-hidden="true" />
      </button>
    </span>
  );
}
