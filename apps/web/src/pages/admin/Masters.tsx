import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePaginatedQuery, useApiMutation } from '../../lib/hooks';
import { api } from '../../lib/api';
import DataTable, { type Column } from '../../components/DataTable';
import Pagination from '../../components/Pagination';
import { INTEREST_RATE_TYPE, LETTER_TEMPLATE_ENTITY_TYPES, MERGE_FIELD_REGISTRY } from '@openestate/shared';

interface MasterTableEntry {
  key: string;
  label: string;
  // Not set anywhere today — every master type shares the same
  // ADMIN_MASTER_READ permission that already gates this whole page (see
  // master.factory.ts). Present only so the empty-category guard below has
  // something real to filter on if a future master type ever gets its own,
  // narrower permission — without this field, that guard would be dead code
  // no one remembered to wire up.
  perm?: string;
}

interface MasterCategory {
  category: string;
  tables: MasterTableEntry[];
}

/**
 * Single declarative source of truth for both the category grouping and the
 * flat per-table config below (MASTER_TABLES is derived from this, not
 * hand-duplicated) — category logic stays in this one config, not scattered
 * through JSX. Order and grouping match the product decision on how staff
 * think about these tables (what they're doing), not the backend module
 * that happens to own the endpoint — same reasoning as AppShell.tsx's own
 * nav SECTIONS.
 */
const MASTER_CATEGORIES: MasterCategory[] = [
  {
    category: 'Leads & Follow-ups',
    tables: [
      { key: 'inquiry-sources', label: 'Inquiry Sources' },
      { key: 'inquiry-types', label: 'Inquiry Types' },
      { key: 'inquiry-temperatures', label: 'Inquiry Temperatures' },
      { key: 'follow-up-types', label: 'Follow-Up Types' },
      { key: 'dump-reasons', label: 'Dump Reasons' },
      { key: 'communication-types', label: 'Communication Types' },
    ],
  },
  {
    category: 'Projects & Inventory',
    tables: [
      { key: 'project-types', label: 'Project Types' },
      { key: 'unit-types', label: 'Unit Types' },
      { key: 'plc-types', label: 'PLC Types' },
      { key: 'area-locations', label: 'Area/Locations' },
    ],
  },
  {
    category: 'Payments & Charges',
    tables: [
      { key: 'receipt-types', label: 'Receipt Types' },
      { key: 'charge-types', label: 'Charge Types' },
      { key: 'payment-plan-templates', label: 'Payment Plan Templates' },
      { key: 'interest-rules', label: 'Interest Rules' },
      { key: 'banks', label: 'Banks' },
    ],
  },
  {
    category: 'Tax & Compliance',
    tables: [
      { key: 'gst-rates', label: 'GST Rates' },
      { key: 'tds-rules', label: 'TDS Rules' },
    ],
  },
  {
    category: 'Bookings & Documents',
    tables: [
      { key: 'registration-types', label: 'Registration Types' },
      { key: 'transfer-fee-rules', label: 'Transfer Fee Rules' },
      { key: 'document-types', label: 'Document Types' },
      { key: 'letter-templates', label: 'Letter Templates' },
    ],
  },
  {
    category: 'Support',
    tables: [{ key: 'ticket-categories', label: 'Ticket Categories' }],
  },
];

const MASTER_TABLES: MasterTableEntry[] = MASTER_CATEGORIES.flatMap((c) => c.tables);

export { MASTER_CATEGORIES };

interface MasterItem {
  id: string;
  name?: string;
  isActive?: boolean;
  sortOrder: number;
  [key: string]: unknown;
}

type FieldType = 'text' | 'number' | 'date' | 'select' | 'asyncSelect' | 'textarea' | 'checkbox';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  // 'asyncSelect' only: options come from a real endpoint (e.g. GST rates
  // are per-company data, not a static enum like the 'select' fields
  // above), fetched by AsyncSelectField below.
  optionsUrl?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  optionLabel?: (item: any) => string;
  required?: boolean;
  // Stored server-side as paise; this field is displayed/edited in rupees.
  moneyField?: boolean;
}

function AsyncSelectField({ f, value, onChange }: { f: FieldDef; value: string; onChange: (v: string) => void }) {
  const { data } = useQuery<{ data: Array<Record<string, unknown>> }>({
    queryKey: ['field-options', f.optionsUrl],
    queryFn: () => api(f.optionsUrl!),
  });
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
    >
      <option value="">Select…</option>
      {data?.data?.map((item) => (
        <option key={item.id as string} value={item.id as string}>
          {f.optionLabel!(item)}
        </option>
      ))}
    </select>
  );
}

// GstRate/TdsRule have no `name` column at all — every other master type does.
const NO_NAME_TABLES = new Set(['gst-rates', 'tds-rules']);

// Fields beyond name/isActive/sortOrder that each master type's own schema
// actually requires or supports. The generic Name-only form below used to
// be the only form for every type, which meant these fields could never be
// set through the UI (document-types/interest-rules/transfer-fee-rules
// simply 400'd on submit; gst-rates/tds-rules/letter-templates had no
// create/edit form at all).
const TYPE_FIELDS: Record<string, FieldDef[]> = {
  'document-types': [{ key: 'entityType', label: 'Entity Type', type: 'text', required: true }],
  // GST State Code is what makes projects in this location bookable at
  // all — place-of-supply resolution fails loud without it, so a location
  // created without one blocks every booking on its projects.
  'area-locations': [
    { key: 'stateCode', label: 'GST State Code (2 digits, e.g. 09 = Uttar Pradesh)', type: 'text' },
    { key: 'city', label: 'City', type: 'text' },
    { key: 'state', label: 'State', type: 'text' },
    { key: 'pincode', label: 'Pincode', type: 'text' },
  ],
  'interest-rules': [
    { key: 'rateType', label: 'Rate Type', type: 'select', options: Object.values(INTEREST_RATE_TYPE), required: true },
    { key: 'ratePercent', label: 'Rate %', type: 'number', required: true },
    { key: 'frequency', label: 'Frequency', type: 'select', options: ['DAILY', 'MONTHLY', 'YEARLY'], required: true },
  ],
  'transfer-fee-rules': [
    { key: 'feeType', label: 'Fee Type', type: 'select', options: ['FIXED', 'PERCENTAGE'], required: true },
    { key: 'amountPaise', label: 'Amount (₹) — if Fixed', type: 'number', moneyField: true },
    { key: 'percentage', label: 'Percentage — if Percentage', type: 'number' },
  ],
  'banks': [{ key: 'ifscPrefix', label: 'IFSC Prefix (e.g. SBIN)', type: 'text' }],
  'payment-plan-templates': [{ key: 'description', label: 'Description', type: 'text' }],
  // gstRateId/hsnSac are real Prisma columns the generic schema never
  // exposed. See booking.service.ts's cost-line loop: a cost line with no
  // gstRateId of its own falls back to its charge type's rate here, then
  // to the booking's base line — never silently zero-rated — so leaving
  // this unset for a charge type doesn't lose the tax, it just defers to
  // the base rate. Still worth setting explicitly wherever it genuinely
  // differs (IFMS, legal charges, statutory pass-throughs).
  'charge-types': [
    {
      key: 'gstRateId',
      label: 'GST Rate',
      type: 'asyncSelect',
      optionsUrl: '/masters/gst-rates?limit=100',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      optionLabel: (g: any) => `${g.rate}% — ${g.description}`,
    },
    { key: 'hsnSac', label: 'HSN/SAC', type: 'text' },
  ],
  'gst-rates': [
    { key: 'rate', label: 'Rate %', type: 'number', required: true },
    { key: 'description', label: 'Description', type: 'text', required: true },
    { key: 'effectiveFrom', label: 'Effective From', type: 'date', required: true },
    { key: 'effectiveTo', label: 'Effective To', type: 'date' },
  ],
  'tds-rules': [
    { key: 'section', label: 'Section', type: 'text', required: true },
    { key: 'ratePercent', label: 'Rate %', type: 'number', required: true },
    { key: 'thresholdPaise', label: 'Threshold (₹)', type: 'number', required: true, moneyField: true },
    { key: 'effectiveFrom', label: 'Effective From', type: 'date', required: true },
    { key: 'effectiveTo', label: 'Effective To', type: 'date' },
    { key: 'description', label: 'Description', type: 'text' },
  ],
  'letter-templates': [
    { key: 'subject', label: 'Subject', type: 'text', required: true },
    { key: 'entityType', label: 'Entity Type', type: 'select', options: LETTER_TEMPLATE_ENTITY_TYPES, required: true },
    { key: 'body', label: 'Body', type: 'textarea', required: true },
  ],
};

function fieldsFor(table: string): FieldDef[] {
  return [
    ...(TYPE_FIELDS[table] ?? []),
    { key: 'sortOrder', label: 'Sort Order', type: 'number' },
    { key: 'isActive', label: 'Active', type: 'checkbox' },
  ];
}

// Distinct from AppShell.tsx's SECTION_STATE_KEY ('openestate.nav.sections')
// — these are two independent sets of collapsible sections (sidebar nav vs.
// this page's category groups) and must not read/overwrite each other's
// stored open/closed state.
const CATEGORY_STATE_KEY = 'openestate.masters.categories';

function readStoredCategoryState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CATEGORY_STATE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    // A corrupt/unavailable localStorage must never break the page —
    // fall back to defaults rather than throwing during render (mirrors
    // AppShell.tsx's readStoredSectionState).
    return {};
  }
}

export default function MastersPage() {
  const qc = useQueryClient();
  const [selectedTable, setSelectedTable] = useState(MASTER_TABLES[0].key);
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<MasterItem | null>(null);
  const [formName, setFormName] = useState('');
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [formError, setFormError] = useState('');
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, boolean>>(
    readStoredCategoryState,
  );

  const toggleCategory = useCallback((label: string, currentlyOpen: boolean) => {
    setCategoryOverrides((prev) => {
      const next = { ...prev, [label]: !currentlyOpen };
      try {
        localStorage.setItem(CATEGORY_STATE_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal: the toggle still works for this session.
      }
      return next;
    });
  }, []);

  // Currently a no-op filter (no MasterTableEntry sets `perm` — every
  // master type shares the page-level ADMIN_MASTER_READ gate) but written
  // the same shape as AppShell.tsx's visibleItems() so a future per-master
  // permission plugs in here without restructuring this function or its
  // callers.
  const visibleTables = (tables: MasterTableEntry[]) => tables;

  /**
   * Open when: the user has explicitly toggled it (their choice always
   * wins, so switching tabs never springs a deliberately-collapsed category
   * back open), otherwise open iff it contains the currently selected
   * table. Mirrors AppShell.tsx's isSectionOpen exactly.
   */
  const isCategoryOpen = (category: MasterCategory, tables: MasterTableEntry[]) => {
    const override = categoryOverrides[category.category];
    if (override !== undefined) return override;
    return tables.some((t) => t.key === selectedTable);
  };

  const { data, isLoading } = usePaginatedQuery<MasterItem>(
    ['masters', selectedTable],
    `/masters/${selectedTable}`,
    { page, limit: 50, sortBy: 'sortOrder', sortOrder: 'asc' },
  );

  const deleteMutation = useApiMutation<unknown, { id: string }>(
    'DELETE',
    (body) => `/masters/${selectedTable}/${body.id}`,
    [['masters', selectedTable]],
  );

  const openCreate = () => {
    setEditItem(null);
    setFormName('');
    const vals: Record<string, string | boolean> = {};
    for (const f of fieldsFor(selectedTable)) {
      vals[f.key] = f.type === 'checkbox' ? true : f.key === 'sortOrder' ? '0' : '';
    }
    setFormValues(vals);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (item: MasterItem) => {
    setEditItem(item);
    setFormName(item.name ?? '');
    const vals: Record<string, string | boolean> = {};
    for (const f of fieldsFor(selectedTable)) {
      if (f.type === 'checkbox') {
        vals[f.key] = (item[f.key] as boolean) ?? true;
        continue;
      }
      const raw = item[f.key];
      if (raw === null || raw === undefined) {
        vals[f.key] = '';
      } else if (f.moneyField) {
        vals[f.key] = String(Number(raw) / 100);
      } else if (f.type === 'date') {
        vals[f.key] = String(raw).slice(0, 10);
      } else {
        vals[f.key] = String(raw);
      }
    }
    setFormValues(vals);
    setFormError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    setFormError('');
    const fields = fieldsFor(selectedTable);
    const body: Record<string, unknown> = {};
    if (!NO_NAME_TABLES.has(selectedTable)) {
      body.name = formName;
    }
    for (const f of fields) {
      if (f.type === 'checkbox') {
        body[f.key] = formValues[f.key] ?? true;
        continue;
      }
      const raw = typeof formValues[f.key] === 'string' ? (formValues[f.key] as string).trim() : '';
      if (raw === '') {
        if (f.required) {
          setFormError(`${f.label} is required`);
          return;
        }
        // An emptied date field means "clear it" — send null explicitly
        // rather than omitting the key, or a PATCH could never reopen a
        // rate once effectiveTo was set (the backend's `.partial()` schema
        // treats an omitted key as "leave unchanged", not "clear").
        if (f.type === 'date') {
          body[f.key] = null;
        }
        continue;
      }
      body[f.key] = f.type === 'number' ? (f.moneyField ? String(Math.round(Number(raw) * 100)) : Number(raw)) : raw;
    }

    try {
      if (editItem) {
        await api(`/masters/${selectedTable}/${editItem.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api(`/masters/${selectedTable}`, { method: 'POST', body: JSON.stringify(body) });
      }
      qc.invalidateQueries({ queryKey: ['masters', selectedTable] });
      setShowForm(false);
      setEditItem(null);
      setFormName('');
      setFormValues({});
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const columns: Column<MasterItem>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (item) => (item.name as string) ?? (item.description as string) ?? (item.section as string) ?? '—',
    },
    {
      key: 'isActive',
      header: 'Active',
      render: (item) => (item.isActive === false ? 'No' : 'Yes'),
    },
    {
      key: 'sortOrder',
      header: 'Sort Order',
      render: (item) => String(item.sortOrder),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (item) => (
        <div className="flex justify-end gap-2">
          <button onClick={() => openEdit(item)} className="text-blue-600 hover:text-blue-800 text-xs">
            Edit
          </button>
          <button
            onClick={() => {
              if (confirm('Delete this item?')) {
                deleteMutation.mutate({ id: item.id });
              }
            }}
            className="text-red-600 hover:text-red-800 text-xs"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  const activeFields = fieldsFor(selectedTable);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">Masters</h1>

      <div className="mt-4 space-y-3">
        {MASTER_CATEGORIES.map((category) => {
          const tables = visibleTables(category.tables);
          // A category the user can see nothing inside must not render at
          // all — not an empty header, not a collapsed shell that opens
          // onto nothing (mirrors AppShell.tsx's identical rule; unreachable
          // today since visibleTables is a no-op, but kept so a future
          // per-master permission doesn't silently produce one).
          if (tables.length === 0) return null;
          const open = isCategoryOpen(category, tables);

          return (
            <div key={category.category}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggleCategory(category.category, open)}
                className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-600"
              >
                <svg
                  className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span>{category.category}</span>
              </button>
              {open && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {tables.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => {
                        setSelectedTable(t.key);
                        setPage(1);
                        setShowForm(false);
                      }}
                      className={`rounded-md px-3 py-1.5 text-sm ${
                        selectedTable === t.key
                          ? 'bg-blue-600 text-white'
                          : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-lg font-medium text-slate-800">
          {MASTER_TABLES.find((t) => t.key === selectedTable)?.label}
        </h2>
        <button
          onClick={openCreate}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Add Item
        </button>
      </div>

      {showForm && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {!NO_NAME_TABLES.has(selectedTable) && (
              <div>
                <label className="block text-sm font-medium text-slate-700">Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            )}
            {activeFields.map((f) => (
              <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                {f.type === 'checkbox' ? (
                  <label className="mt-6 flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(formValues[f.key] as boolean) ?? true}
                      onChange={(e) => setFormValues((p) => ({ ...p, [f.key]: e.target.checked }))}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                    <span className="text-sm text-slate-700">{f.label}</span>
                  </label>
                ) : (
                  <>
                    <label className="block text-sm font-medium text-slate-700">{f.label}</label>
                    {f.type === 'select' ? (
                      <select
                        value={(formValues[f.key] as string) ?? ''}
                        onChange={(e) => setFormValues((p) => ({ ...p, [f.key]: e.target.value }))}
                        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      >
                        <option value="">Select…</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : f.type === 'asyncSelect' ? (
                      <AsyncSelectField
                        f={f}
                        value={(formValues[f.key] as string) ?? ''}
                        onChange={(v) => setFormValues((p) => ({ ...p, [f.key]: v }))}
                      />
                    ) : f.type === 'textarea' ? (
                      <textarea
                        value={(formValues[f.key] as string) ?? ''}
                        onChange={(e) => setFormValues((p) => ({ ...p, [f.key]: e.target.value }))}
                        rows={4}
                        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    ) : (
                      <input
                        type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                        value={(formValues[f.key] as string) ?? ''}
                        onChange={(e) => setFormValues((p) => ({ ...p, [f.key]: e.target.value }))}
                        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                      />
                    )}
                    {f.key === 'entityType' &&
                      selectedTable === 'letter-templates' &&
                      formValues.entityType && (
                        <p className="mt-1 text-xs text-slate-500">
                          Merge fields:{' '}
                          {MERGE_FIELD_REGISTRY[formValues.entityType as keyof typeof MERGE_FIELD_REGISTRY]
                            ?.map((mf) => `{{${mf}}}`)
                            .join(', ')}
                        </p>
                      )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-3">
            <button
              onClick={handleSave}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              {editItem ? 'Update' : 'Create'}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setEditItem(null);
              }}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
          {selectedTable === 'interest-rules' && (
            <p className="mt-2 text-xs text-slate-500">
              Only SIMPLE rules can be attached to bookings for now. A rule attached to an active booking keeps its
              rate type and rate; to change the rate, create a new rule and change the bookings to it.
            </p>
          )}
          {formError && <p className="mt-2 text-sm text-red-600">{formError}</p>}
        </div>
      )}

      <div className="mt-4">
        <DataTable columns={columns} data={data?.data ?? []} isLoading={isLoading} />
        {data?.meta && (
          <Pagination page={data.meta.page} totalPages={data.meta.totalPages} onPageChange={setPage} />
        )}
      </div>
    </div>
  );
}
