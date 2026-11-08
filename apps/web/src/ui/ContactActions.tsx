import { MessageCircle, Phone } from 'lucide-react';
import { whatsAppNumber } from '@openestate/shared';

const ICON_LINK =
  'inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-2 hover:bg-surface-muted hover:text-fg';

/**
 * Call (tel:) and WhatsApp (wa.me) links for one person, each named with
 * who it reaches ("Call Priya Sharma"). WhatsApp is left out when the
 * number's country can't be known.
 */
export function ContactActions({ name, phone }: { name: string; phone: string | null | undefined }) {
  if (!phone) return null;
  const wa = whatsAppNumber(phone);
  return (
    <span className="inline-flex items-center gap-1">
      <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} aria-label={`Call ${name}`} title={`Call ${name}`} className={ICON_LINK}>
        <Phone size={18} aria-hidden="true" />
      </a>
      {wa && (
        <a
          href={`https://wa.me/${wa}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`WhatsApp ${name}`}
          title={`WhatsApp ${name}`}
          className={ICON_LINK}
        >
          <MessageCircle size={18} aria-hidden="true" />
        </a>
      )}
    </span>
  );
}
