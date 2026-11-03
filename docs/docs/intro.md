---
id: intro
title: Introduction
slug: /
---

# OpenEstate

OpenEstate is an open-source (AGPL-3.0), self-hostable CRM for real estate —
pre-sales lead management, post-sales unit/installment/receipt management, a
customer portal, and a broker portal. Its plugin system lets other verticals
adapt it without forking core code.

As of v0.8.5, the core sales funnel — auth/RBAC, multi-tenancy, inventory
(unit-based and plotted/farmhouse land sales), a configurable lead-stage
pipeline, manager-hierarchy-scoped lead visibility, pre-sales (including an
expanded reporting suite), the post-sales ledger, brokers/commissions, both
portals, plugins, webhooks, and custom fields — is built and exercised end
to end. v0.8.5 is a security fix: in a shared browser, one signed-in account could see another's data or act as another account, so every install should upgrade; it needs a newer browser, so read its release notes first. v0.8.4 hardens upgrades and the database and changes some behaviour (the API now listens on 127.0.0.1 only, and the upgrade script refuses to go backwards), so read its release notes before upgrading. v0.8.3 is a security fix: a broker portal session could download customers' stored documents, so every install should upgrade. v0.8.2 is a security fix: an administrator could act beyond their own permissions, so every install should upgrade. v0.8.1 is a security fix: a signed-in customer or broker portal
session could call staff API routes, so every install should upgrade.
v0.8.0 adds a safety net against accidentally storing Aadhaar
numbers in custom fields — deterrence, not prevention; v0.7.1 is a security fix to the audit log — most create, update
and delete actions had never been recorded, and rows had no user or IP
address; v0.7.0 lets an admin clear a user's two-factor authentication —
staff, portal, or a locked-out sole admin via the break-glass CLI; v0.6.1
fixes recovery-code sign-in on the staff two-factor screen; v0.6.0 added
admin-issued, one-time password-reset links for staff and portal users (no
mail server needed); v0.5.0 was a security release that closed a
two-factor-authentication bypass and made 2FA codes resistant to
guessing — see
[SECURITY.md](https://github.com/stemAGH/openestate/blob/master/SECURITY.md)
if you're upgrading from a version before that. See the
[known gaps](./features-and-usage.md#known-gaps-before-you-run-a-real-project-on-this)
before relying on it for a real pilot.

- **Install** — [native install SOP: prerequisites, first-login checklist, backups, upgrades](./installation.md)
- **Admin guide** — [feature walkthrough by module, including the customer and broker portals](./features-and-usage.md)
- **API reference** — live, generated from the OpenAPI spec: `/api/v1/docs` on your own running instance (not a static page here)
- **Customization guide** — custom fields, terminology, and module flags are covered in the
  [Admin guide's Customization section](./features-and-usage.md#7-customization--this-isnt-just-for-real-estate)
- **Plugin development** — not yet written as a standalone guide; the
  [`generic-sales`](https://github.com/stemAGH/openestate/tree/master/plugins/generic-sales)
  plugin is the closest thing to one today — read it alongside
  `packages/plugin-sdk` for the capability-gated `PluginContext` API
- **Security** — [ASVS L2 self-assessment](./security/asvs-checklist.md)
  and [STRIDE threat model](./security/threat-model.md);
  disclosure policy in the repo's [SECURITY.md](https://github.com/stemAGH/openestate/blob/master/SECURITY.md)
