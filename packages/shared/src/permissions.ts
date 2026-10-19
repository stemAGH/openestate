export const PERMISSIONS = {
  // ── Admin ──────────────────────────────────────────
  ADMIN_COMPANY_READ: 'admin.company.read',
  ADMIN_COMPANY_UPDATE: 'admin.company.update',
  ADMIN_USER_READ: 'admin.user.read',
  ADMIN_USER_CREATE: 'admin.user.create',
  ADMIN_USER_UPDATE: 'admin.user.update',
  ADMIN_USER_DEACTIVATE: 'admin.user.deactivate',
  ADMIN_ROLE_READ: 'admin.role.read',
  ADMIN_ROLE_CREATE: 'admin.role.create',
  ADMIN_ROLE_UPDATE: 'admin.role.update',
  ADMIN_ROLE_DELETE: 'admin.role.delete',
  ADMIN_MASTER_READ: 'admin.master.read',
  ADMIN_MASTER_CREATE: 'admin.master.create',
  ADMIN_MASTER_UPDATE: 'admin.master.update',
  ADMIN_MASTER_DELETE: 'admin.master.delete',
  ADMIN_CUSTOM_FIELD_READ: 'admin.custom-field.read',
  ADMIN_CUSTOM_FIELD_CREATE: 'admin.custom-field.create',
  ADMIN_CUSTOM_FIELD_UPDATE: 'admin.custom-field.update',
  ADMIN_CUSTOM_FIELD_DELETE: 'admin.custom-field.delete',
  // Phase 5: broker + bank-detail + commission-rule CRUD.
  ADMIN_BROKER_READ: 'admin.broker.read',
  ADMIN_BROKER_CREATE: 'admin.broker.create',
  ADMIN_BROKER_UPDATE: 'admin.broker.update',
  ADMIN_CONFIG_READ: 'admin.config.read',
  ADMIN_CONFIG_UPDATE: 'admin.config.update',
  ADMIN_AUDIT_READ: 'admin.audit.read',
  // Phase 6: portal-facing staff workflows.
  ADMIN_CHANGE_REQUEST_APPROVE: 'admin.change-request.approve',
  ADMIN_TICKET_RESPOND: 'admin.ticket.respond',
  ADMIN_PORTAL_INVITE_SEND: 'admin.portal-invite.send',
  ADMIN_CONSTRUCTION_UPDATE_MANAGE: 'admin.construction-update.manage',
  // Phase 7: plugin install/enable/configure. Same 2-permission
  // read/manage shape as ADMIN_CONFIG_READ/UPDATE — plugin admin isn't
  // granular enough (install vs configure vs enable) to warrant 5
  // separate keys the way booking/unit actions are.
  ADMIN_PLUGIN_READ: 'admin.plugin.read',
  ADMIN_PLUGIN_MANAGE: 'admin.plugin.manage',
  // Phase 7 commit 2: webhook endpoint CRUD + delivery retry, and
  // inbound-lead API key CRUD. Same 2-permission read/manage shape.
  ADMIN_WEBHOOK_READ: 'admin.webhook.read',
  ADMIN_WEBHOOK_MANAGE: 'admin.webhook.manage',
  ADMIN_LEAD_API_KEY_READ: 'admin.lead-api-key.read',
  ADMIN_LEAD_API_KEY_MANAGE: 'admin.lead-api-key.manage',
  // Exempts the holder from reporting-line scoping: they see every user's
  // leads, reports and dashboard figures company-wide, regardless of where
  // they sit (or don't sit) in the org chart. TeamScopeService keys off
  // THIS, not off the role slug — a company that builds its own
  // "Administrator" role with every permission must behave like an admin,
  // and before this it was silently scoped to its own subtree instead
  // (its dashboard simply looked broken, with no error to explain why).
  // Deliberately NOT granted to sales_manager: a manager seeing their own
  // subtree is the whole point of the hierarchy.
  ADMIN_TEAM_SCOPE_ALL: 'admin.team-scope.all',

  // ── Inventory ─────────────────────────────────────
  INVENTORY_PROJECT_READ: 'inventory.project.read',
  INVENTORY_PROJECT_CREATE: 'inventory.project.create',
  INVENTORY_PROJECT_UPDATE: 'inventory.project.update',
  INVENTORY_PROJECT_DELETE: 'inventory.project.delete',
  INVENTORY_TOWER_READ: 'inventory.tower.read',
  INVENTORY_TOWER_CREATE: 'inventory.tower.create',
  INVENTORY_TOWER_UPDATE: 'inventory.tower.update',
  INVENTORY_TOWER_DELETE: 'inventory.tower.delete',
  // LAND_BASED-project analog of tower management — Sector/Block/Cluster
  // create/edit/deactivate. See plotted-farmhouse-inventory.md §8; no
  // separate READ permission — Unit read already covers groups via the
  // Unit-list response.
  INVENTORY_INVENTORY_GROUP_MANAGE: 'inventory.inventory-group.manage',
  INVENTORY_UNIT_READ: 'inventory.unit.read',
  INVENTORY_UNIT_CREATE: 'inventory.unit.create',
  INVENTORY_UNIT_UPDATE: 'inventory.unit.update',
  INVENTORY_UNIT_BULK_GENERATE: 'inventory.unit.bulk-generate',
  INVENTORY_UNIT_IMPORT: 'inventory.unit.import',
  INVENTORY_UNIT_EXPORT: 'inventory.unit.export',
  INVENTORY_UNIT_HOLD: 'inventory.unit.hold',
  INVENTORY_UNIT_BOOK: 'inventory.unit.book',
  INVENTORY_UNIT_BLOCK: 'inventory.unit.block',
  INVENTORY_UNIT_ALLOT: 'inventory.unit.allot',
  INVENTORY_UNIT_REGISTER: 'inventory.unit.register',
  INVENTORY_UNIT_CANCEL: 'inventory.unit.cancel',
  INVENTORY_UNIT_RELEASE: 'inventory.unit.release',
  INVENTORY_RATE_READ: 'inventory.rate.read',
  INVENTORY_RATE_CHANGE: 'inventory.rate.change',
  INVENTORY_UPLOAD_READ: 'inventory.upload.read',
  INVENTORY_UPLOAD_CREATE: 'inventory.upload.create',
  INVENTORY_UPLOAD_DELETE: 'inventory.upload.delete',
  INVENTORY_UNIT_PLC_MANAGE: 'inventory.unit.plc-manage',
  INVENTORY_UNIT_CHARGE_MANAGE: 'inventory.unit.charge-manage',

  // ── Presales ───────────────────────────────────────
  PRESALES_APPLICANT_READ: 'presales.applicant.read',
  PRESALES_APPLICANT_CREATE: 'presales.applicant.create',
  PRESALES_APPLICANT_UPDATE: 'presales.applicant.update',
  PRESALES_APPLICANT_MERGE: 'presales.applicant.merge',
  PRESALES_INQUIRY_READ: 'presales.inquiry.read',
  PRESALES_INQUIRY_CREATE: 'presales.inquiry.create',
  PRESALES_INQUIRY_UPDATE: 'presales.inquiry.update',
  PRESALES_INQUIRY_DELETE: 'presales.inquiry.delete',
  PRESALES_INQUIRY_ASSIGN: 'presales.inquiry.assign',
  PRESALES_INQUIRY_IMPORT: 'presales.inquiry.import',
  PRESALES_FOLLOW_UP_READ: 'presales.follow-up.read',
  PRESALES_FOLLOW_UP_CREATE: 'presales.follow-up.create',
  PRESALES_FOLLOW_UP_UPDATE: 'presales.follow-up.update',
  PRESALES_SITE_VISIT_READ: 'presales.site-visit.read',
  PRESALES_SITE_VISIT_CREATE: 'presales.site-visit.create',
  PRESALES_SITE_VISIT_UPDATE: 'presales.site-visit.update',
  PRESALES_COMMUNICATION_SEND: 'presales.communication.send',
  PRESALES_ASSIGNMENT_POOL_MANAGE: 'presales.assignment-pool.manage',
  PRESALES_REPORT_VIEW: 'presales.report.view',
  // Separate from .view so a role can read a report on-screen without
  // exfiltrating customer PII via CSV/print — see CLAUDE.md's presales
  // reporting suite decisions. company_admin/sales_manager inherit both
  // automatically via the `presales.` prefix filter in roles.ts; on an
  // EXISTING install upgrading, that prefix filter only seeds a brand-new
  // role — an admin must grant these two explicitly via Admin > Roles
  // (see the standing "does an existing install actually receive a new
  // PERMISSIONS key" upgrade-path rule).
  PRESALES_REPORT_EXPORT: 'presales.report.export',
  PRESALES_REPORT_PRINT: 'presales.report.print',

  // ── Postsales ──────────────────────────────────────
  POSTSALES_BOOKING_READ: 'postsales.booking.read',
  POSTSALES_BOOKING_CREATE: 'postsales.booking.create',
  POSTSALES_BOOKING_UPDATE: 'postsales.booking.update',
  POSTSALES_BOOKING_ALLOT: 'postsales.booking.allot',
  POSTSALES_BOOKING_REGISTER: 'postsales.booking.register',
  POSTSALES_BOOKING_CANCEL: 'postsales.booking.cancel',
  POSTSALES_PLAN_READ: 'postsales.plan.read',
  POSTSALES_PLAN_EDIT: 'postsales.plan.edit',
  POSTSALES_UNIT_READ: 'postsales.unit.read',
  POSTSALES_UNIT_UPDATE: 'postsales.unit.update',
  POSTSALES_DEMAND_READ: 'postsales.demand.read',
  POSTSALES_DEMAND_GENERATE: 'postsales.demand.generate',
  // Raising a construction-linked stage (setting real due dates, starting
  // the interest clock) — deliberately separate from DEMAND_GENERATE,
  // which only renders an already-due installment's letter PDF. See
  // docs/plans/construction-linked-demand-fix.md.
  POSTSALES_DEMAND_RAISE: 'postsales.demand.raise',
  POSTSALES_RECEIPT_READ: 'postsales.receipt.read',
  POSTSALES_RECEIPT_CREATE: 'postsales.receipt.create',
  POSTSALES_RECEIPT_CANCEL: 'postsales.receipt.cancel',
  POSTSALES_CHEQUE_VERIFY: 'postsales.cheque.verify',
  POSTSALES_EXTRA_CHARGE_CREATE: 'postsales.extra-charge.create',
  POSTSALES_INTEREST_WAIVE: 'postsales.interest.waive',
  // Attach, change or remove a booking's delay-interest rule. Separate from
  // WAIVE: attaching a rule raises what a customer owes, waiving lowers it.
  POSTSALES_INTEREST_MANAGE: 'postsales.interest.manage',
  POSTSALES_TDS_READ: 'postsales.tds.read',
  POSTSALES_TDS_CERTIFICATE: 'postsales.tds.certificate',
  POSTSALES_TRANSFER_READ: 'postsales.transfer.read',
  POSTSALES_TRANSFER_CREATE: 'postsales.transfer.create',
  POSTSALES_TRANSFER_APPROVE: 'postsales.transfer.approve',
  POSTSALES_REFUND_REQUEST: 'postsales.refund.request',
  POSTSALES_REFUND_APPROVE: 'postsales.refund.approve',
  POSTSALES_REFUND_PAY: 'postsales.refund.pay',
  POSTSALES_DOCUMENT_READ: 'postsales.document.read',
  POSTSALES_DOCUMENT_UPLOAD: 'postsales.document.upload',
  POSTSALES_DOCUMENT_DELETE: 'postsales.document.delete',
  POSTSALES_LETTER_READ: 'postsales.letter.read',
  POSTSALES_LETTER_GENERATE: 'postsales.letter.generate',
  POSTSALES_DISPATCH_SEND: 'postsales.dispatch.send',
  POSTSALES_DISPATCH_READ: 'postsales.dispatch.read',
  // Phase 5: request an NOC — same holder as POSTSALES_BOOKING_CANCEL
  // (the person who can cancel is the person who can ask a sourcing
  // broker for no-objection).
  POSTSALES_NOC_REQUEST: 'postsales.noc.request',

  // ── Accounts ───────────────────────────────────────
  ACCOUNTS_RECEIPT_VERIFY: 'accounts.receipt.verify',
  ACCOUNTS_PAYMENT_READ: 'accounts.payment.read',
  ACCOUNTS_PAYMENT_CREATE: 'accounts.payment.create',
  ACCOUNTS_COMMISSION_READ: 'accounts.commission.read',
  // Phase 5: three-permission dual-control on CommissionPayment
  // (REQUESTED → APPROVED → PAID) — create ≠ approve ≠ pay, matching the
  // refund dual-control precedent.
  ACCOUNTS_COMMISSION_CREATE: 'accounts.commission.create',
  ACCOUNTS_COMMISSION_APPROVE: 'accounts.commission.approve',
  ACCOUNTS_COMMISSION_PAY: 'accounts.commission.pay',
  ACCOUNTS_NOC_APPROVE: 'accounts.noc.approve',

  // ── Reports ────────────────────────────────────────
  REPORTS_SALES_VIEW: 'reports.sales.view',
  REPORTS_COLLECTION_VIEW: 'reports.collection.view',
  REPORTS_OUTSTANDING_VIEW: 'reports.outstanding.view',
  REPORTS_BROKER_VIEW: 'reports.broker.view',
  REPORTS_GST_VIEW: 'reports.gst.view',
  REPORTS_CUSTOM_CREATE: 'reports.custom.create',
  REPORTS_APPLICANT_LEDGER_VIEW: 'reports.applicant-ledger.view',
  REPORTS_BIRTHDAY_VIEW: 'reports.birthday.view',

  // ── Portal ─────────────────────────────────────────
  PORTAL_BOOKING_READ: 'portal.booking.read',
  PORTAL_RECEIPT_READ: 'portal.receipt.read',
  PORTAL_DOCUMENT_READ: 'portal.document.read',
  PORTAL_DOCUMENT_UPLOAD: 'portal.document.upload',
  PORTAL_PAYMENT_SCHEDULE_READ: 'portal.payment-schedule.read',
  PORTAL_PROFILE_UPDATE: 'portal.profile.update',
  // Phase 6.
  PORTAL_CHANGE_REQUEST_CREATE: 'portal.change-request.create',
  PORTAL_TICKET_CREATE: 'portal.ticket.create',
  PORTAL_TICKET_READ: 'portal.ticket.read',
  // Broker portal NOC action — deliberately distinct from staff's
  // accounts.noc.approve; never granted to sales_manager/accounts.
  PORTAL_NOC_ACTION: 'portal.noc.action',
  PORTAL_CONSTRUCTION_UPDATE_READ: 'portal.construction-update.read',
  // The broker's own dashboard. Portal roles hold only portal.* keys, so
  // this is not the staff reports.broker.view.
  PORTAL_BROKER_DASHBOARD_READ: 'portal.broker.dashboard.read',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const PERMISSION_MODULES = [
  'admin',
  'inventory',
  'presales',
  'postsales',
  'accounts',
  'reports',
  'portal',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
