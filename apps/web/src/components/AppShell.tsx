import { useCallback, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { PERMISSIONS } from '@openestate/shared';
import { ChevronRight, Menu } from 'lucide-react';
import { IconButton } from '../ui';

interface NavLeaf {
  label: string;
  to: string;
  perm?: string;
}

interface NavSection {
  label: string;
  items: NavLeaf[];
}

/** Always visible, never inside a collapsible section. */
const TOP_LEVEL: NavLeaf[] = [{ label: 'Dashboard', to: '/' }];

/**
 * Section membership follows what a user is DOING, not which backend
 * module happens to own the endpoint — "Brokers" and "Reports" are their
 * own sections rather than buried under Post-Sales, even though both are
 * postsales routes. Each currently holds a single link; that is expected
 * to grow and is cheaper than re-teaching the nav later.
 */
const SECTIONS: NavSection[] = [
  {
    label: 'Pre-Sales',
    items: [
      { label: 'Inquiries', to: '/presales/inquiries', perm: PERMISSIONS.PRESALES_INQUIRY_READ },
      { label: 'Reports', to: '/presales/reports', perm: PERMISSIONS.PRESALES_REPORT_VIEW },
    ],
  },
  {
    label: 'Inventory',
    items: [{ label: 'Projects', to: '/inventory/projects', perm: PERMISSIONS.INVENTORY_PROJECT_READ }],
  },
  {
    label: 'Post-Sales',
    items: [
      { label: 'New Booking', to: '/postsales/bookings/new', perm: PERMISSIONS.POSTSALES_BOOKING_CREATE },
      { label: 'Receipt Entry', to: '/postsales/receipts/new', perm: PERMISSIONS.POSTSALES_RECEIPT_CREATE },
      { label: 'Cheque Queue', to: '/postsales/cheques', perm: PERMISSIONS.POSTSALES_CHEQUE_VERIFY },
      { label: 'Dues Dashboard', to: '/postsales/dues', perm: PERMISSIONS.REPORTS_OUTSTANDING_VIEW },
    ],
  },
  {
    label: 'Brokers',
    items: [{ label: 'Brokers', to: '/postsales/brokers', perm: PERMISSIONS.ADMIN_BROKER_READ }],
  },
  {
    label: 'Reports',
    items: [{ label: 'Post-Sales Reports', to: '/postsales/reports', perm: PERMISSIONS.REPORTS_COLLECTION_VIEW }],
  },
  {
    label: 'Support',
    items: [{ label: 'Tickets', to: '/support/tickets', perm: PERMISSIONS.ADMIN_TICKET_RESPOND }],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Users', to: '/admin/users', perm: PERMISSIONS.ADMIN_USER_READ },
      { label: 'Hierarchy', to: '/admin/hierarchy', perm: PERMISSIONS.ADMIN_USER_READ },
      { label: 'Roles', to: '/admin/roles', perm: PERMISSIONS.ADMIN_ROLE_READ },
      { label: 'Masters', to: '/admin/masters', perm: PERMISSIONS.ADMIN_MASTER_READ },
      { label: 'Custom Fields', to: '/admin/custom-fields', perm: PERMISSIONS.ADMIN_CUSTOM_FIELD_READ },
      { label: 'Letter Templates', to: '/admin/letter-templates', perm: PERMISSIONS.ADMIN_MASTER_READ },
      { label: 'Lead Stages', to: '/admin/lead-stages', perm: PERMISSIONS.ADMIN_MASTER_READ },
      { label: 'Company Config', to: '/admin/config', perm: PERMISSIONS.ADMIN_CONFIG_READ },
      { label: 'Audit Log', to: '/admin/audit', perm: PERMISSIONS.ADMIN_AUDIT_READ },
      { label: 'Plugins', to: '/admin/plugins', perm: PERMISSIONS.ADMIN_PLUGIN_READ },
      { label: 'Webhooks', to: '/admin/webhooks', perm: PERMISSIONS.ADMIN_WEBHOOK_READ },
      { label: 'Lead API Keys', to: '/admin/lead-api-keys', perm: PERMISSIONS.ADMIN_LEAD_API_KEY_READ },
    ],
  },
];

/** Personal settings — bottom of the nav, outside the work sections. */
const BOTTOM_LEVEL: NavLeaf[] = [{ label: 'Settings', to: '/settings' }];

const SECTION_STATE_KEY = 'openestate.nav.sections';

function readStoredSectionState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_STATE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    // A corrupt/unavailable localStorage must never break the nav —
    // fall back to defaults rather than throwing during render.
    return {};
  }
}

const linkClasses = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${
    isActive
      ? 'bg-blue-50 text-blue-700 font-medium'
      : 'text-slate-700 hover:bg-slate-100'
  }`;

interface CompanyConfigGstFields {
  companyGstin: string | null;
  gstStateCode: string | null;
}

/**
 * isIntraStateSupply() (packages/shared) now throws instead of silently
 * defaulting to intra-state GST when either the company's or a booking's
 * place-of-supply state code is missing — a company with incomplete GST
 * config can no longer create bookings or extra charges at all, with no
 * on-screen indication of why until someone hits the error. Shown to
 * anyone who can read Company Config (same permission that gates the nav
 * link), on every page, not just Company Config itself, since the error
 * surfaces on Booking/Receipt screens, not there.
 */
function GstConfigBanner() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission(PERMISSIONS.ADMIN_CONFIG_READ);
  const { data } = useQuery<CompanyConfigGstFields>({
    queryKey: ['company-config'],
    queryFn: () => api('/company/config'),
    enabled: canRead,
  });
  if (!canRead || !data || (data.companyGstin && data.gstStateCode)) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 lg:px-6">
      GST configuration is incomplete — bookings and extra charges will be
      rejected until it's set.{' '}
      <Link to="/admin/config" className="font-medium underline hover:text-amber-900">
        Complete Company Config
      </Link>
    </div>
  );
}

/**
 * Bookings created before the base-line GST rate picker existed can have
 * a BASE cost line with no gstRateId — snapshotted at 0% GST, silently,
 * on every generated document. `BookingCostLine` is immutable, so these
 * can't be fixed retroactively; this only tells an admin they exist and
 * exactly where to find them, mirroring GstConfigBanner's shape.
 */
function ZeroGstBookingsBanner() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission(PERMISSIONS.REPORTS_SALES_VIEW);
  const { data } = useQuery<{ count: number }>({
    queryKey: ['zero-gst-bookings-count'],
    queryFn: () => api('/reports/postsales/zero-gst-bookings-count'),
    enabled: canRead,
  });
  if (!canRead || !data || data.count === 0) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 lg:px-6">
      {data.count} booking{data.count === 1 ? '' : 's'} {data.count === 1 ? 'has' : 'have'} no GST rate
      on its base cost line — printed documents for {data.count === 1 ? 'it' : 'them'} may show ₹0 GST.{' '}
      <Link to="/postsales/reports" className="font-medium underline hover:text-amber-900">
        Post-sales → Reports → "Zero-GST bookings"
      </Link>{' '}
      lists the affected booking numbers.
    </div>
  );
}

export default function AppShell() {
  const { user, logout, hasPermission } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, boolean>>(
    readStoredSectionState,
  );
  const { pathname } = useLocation();

  const toggleSection = useCallback((label: string, currentlyOpen: boolean) => {
    setSectionOverrides((prev) => {
      const next = { ...prev, [label]: !currentlyOpen };
      try {
        localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal: the toggle still works for this session.
      }
      return next;
    });
  }, []);

  const visibleItems = (items: NavLeaf[]) => items.filter((i) => !i.perm || hasPermission(i.perm));

  /**
   * Open when: the user has explicitly toggled it (their choice always
   * wins, so navigating never springs a deliberately-collapsed section
   * back open), otherwise open iff it contains the current route. The
   * explicit map is persisted, so both the choice and the sensible
   * default survive a full page reload, not just client-side navigation.
   */
  const isSectionOpen = (section: NavSection, items: NavLeaf[]) => {
    const override = sectionOverrides[section.label];
    if (override !== undefined) return override;
    return items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  };

  return (
    <div className="min-h-screen flex bg-bg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary focus:shadow-lg"
      >
        Skip to main content
      </a>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        // Wide screens: the sidebar stays put at full height while the page
        // scrolls, and its nav scrolls on its own (flex column, nav flex-1).
        className={`fixed inset-y-0 left-0 z-30 flex w-64 shrink-0 transform flex-col bg-white border-r border-slate-200 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:z-auto ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center border-b border-slate-200 px-4">
          <Link to="/" className="text-lg font-semibold text-slate-900">
            OpenEstate
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {visibleItems(TOP_LEVEL).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end
              className={linkClasses}
              onClick={() => setSidebarOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}

          {SECTIONS.map((section) => {
            const items = visibleItems(section.items);
            // A section the user can see nothing inside must not render at
            // all — not an empty header, not a collapsed shell that opens
            // onto nothing.
            if (items.length === 0) return null;
            const open = isSectionOpen(section, items);

            return (
              <div key={section.label}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleSection(section.label, open)}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wider text-fg-2 hover:bg-slate-100 hover:text-fg"
                >
                  <span>{section.label}</span>
                  <ChevronRight
                    aria-hidden="true"
                    className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                </button>
                {open &&
                  items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={linkClasses}
                      onClick={() => setSidebarOpen(false)}
                    >
                      {item.label}
                    </NavLink>
                  ))}
              </div>
            );
          })}

          {visibleItems(BOTTOM_LEVEL).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={linkClasses}
              onClick={() => setSidebarOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-200 p-3">
          <div className="text-sm text-slate-700 truncate px-3">{user?.email}</div>
          <button
            onClick={logout}
            className="mt-2 w-full rounded-md px-3 py-2 text-sm text-red-600 hover:bg-red-50 text-left"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Sticky on phones (it holds the menu button); on wide screens it scrolls
            away with the page, so it never sits over page content. */}
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-slate-200 bg-white px-4 lg:static lg:px-6">
          <IconButton
            label="Open menu"
            className="lg:hidden"
            onClick={() => setSidebarOpen(true)}
            icon={<Menu aria-hidden="true" className="h-5 w-5" />}
          />
          <div className="flex-1" />
          <span className="text-sm text-slate-500 hidden sm:inline">{user?.email}</span>
        </header>

        <GstConfigBanner />
        <ZeroGstBookingsBanner />

        <main id="main" tabIndex={-1} className="flex-1 p-4 focus:outline-none lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
