> **Provenance note (added when this file was saved into the repo,
> 2026-08-28):** this document is an external specification, not an
> OpenEstate design artifact. It is derived from a real business process
> document — **"SOP: LeadSync – Lead Follow-up and Disposition
> Management"** — supplied by the user. Treat its content as a source of
> truth about how the underlying sales team's follow-up process actually
> works, the same way the project's internal plans treat other planning
> inputs. It is saved here verbatim (no edits below this note) so it can be
> referenced by file path rather than only existing as a chat attachment.
> The comparison against what OpenEstate already has is kept in the
> project's internal plans.

---

# Follow-Up Page — Functional Specification & Architecture

> **Purpose:** Source-of-truth specification for implementing the Follow-Up page and follow-up lifecycle in the open-source CRM.
>
> **Source basis:** This specification is derived from the provided **"SOP: LeadSync – Lead Follow-up and Disposition Management."** Where this document proposes implementation details that are not explicitly defined by the SOP, they are marked as **Implementation Recommendation** rather than presented as existing business rules.

---

## 1. Overview

The Follow-Up page is the operational workspace used by CRM users to manage ongoing engagement with leads.

Its primary purpose is to ensure that every lead interaction is:

1. recorded,
2. associated with the correct lead,
3. assigned a standardized response/status,
4. given a next follow-up date/time when continued engagement is required,
5. associated with a communication channel,
6. documented with remarks and customer information,
7. and ultimately moved into the correct disposition: **Followups, Transfer, Successful, or Dump**.

The SOP defines the navigation path as:

**Dashboard → Lead → Enquiry → Followups**

The Follow-Up page therefore sits within the Lead/Enquiry workflow rather than functioning as an isolated task list.

---

## 2. Core Business Objective

The Follow-Up module exists to prevent leads from becoming unmanaged or idle.

The SOP explicitly identifies four operational goals:

- timely follow-up,
- structured communication,
- status tracking,
- conversion or disposition of leads.

A compliant implementation should make it difficult for a user to complete an interaction without recording the outcome and deciding what happens next.

The SOP also requires:

- standardized responses for reporting consistency,
- status updates after interactions,
- no lead remaining idle beyond its scheduled follow-up time,
- weekly supervisor review of dumped and transferred leads.

---

## 3. Conceptual Model

The central object is the **Lead**.

A lead may have:

- customer/contact information,
- enquiry/requirement information,
- an assigned owner,
- one or more follow-up records,
- a current lifecycle/disposition state,
- a history of communications and status changes.

A **Follow-Up** is an interaction/event associated with a lead.

A follow-up records what happened during an interaction and, where applicable, schedules the next interaction.

### High-level relationship

```text
Lead
 ├── Customer Details
 ├── Enquiry / Requirement Details
 ├── Current Owner
 ├── Current Lifecycle / Disposition
 └── Follow-Up History
      ├── Follow-Up #1
      ├── Follow-Up #2
      ├── Follow-Up #3
      └── ...
```

A follow-up should therefore be treated as a historical record rather than simply a mutable field on the lead.

---

## 4. Follow-Up Lifecycle

The lifecycle described by the SOP is:

```text
                    ┌───────────────┐
                    │     LEAD      │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   Follow-Up   │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
         Followups       Transfer      Successful
              │             │             │
              │             ▼             ▼
              │        New Owner      Conversion
              │        Follow-Up        List
              │
              ▼
       Next Follow-Up
              │
              └───────────► Follow-Up

              Another terminal path:

                    Follow-Up
                       │
                       ▼
                     Dump
                       │
                       ▼
                Closed / Invalid
```

### Lifecycle actions

| Action | Meaning | Result |
|---|---|---|
| **Followups** | Continue engagement with the lead | Lead remains in follow-up workflow |
| **Transfer** | Reassign lead to another employee/senior | New owner receives the lead in their follow-up queue |
| **Successful** | Lead has confirmed booking | Lead moves to conversion list |
| **Dump** | Lead is no longer a valid prospect | Lead is closed with a reason and remarks |

These four options are explicitly described by the SOP.

---

# 5. Follow-Up Page Responsibilities

The page should support five major operations:

1. **Find leads**
2. **Review lead/customer/enquiry context**
3. **Record a follow-up**
4. **Change lead disposition**
5. **Review follow-up history**

The page should not be treated as only a database table. It is an operational workflow screen.

---

## 6. Lead Search and Filtering

The SOP instructs users to navigate to the Followups section and use filters to locate specific leads.

Examples explicitly mentioned are:

- **Dump**
- **Contacted**

The user then clicks **Search** to retrieve matching entries.

### Search interaction

```text
Open Followups
      │
      ▼
Set filter(s)
      │
      ▼
Click Search
      │
      ▼
Retrieve matching leads
      │
      ▼
Select lead
      │
      ▼
Perform follow-up / disposition action
```

### UI requirements

The Follow-Up page should provide:

- a filter/search area,
- a Search action,
- a result list/table,
- an obvious row-level mechanism to open or act on a lead,
- filtering based on lifecycle/status information.

**Implementation Recommendation:** Additional filters may be introduced later, but they should not change the meaning of the SOP-defined statuses.

Potential future filters include:

- lead owner,
- project,
- source,
- response,
- sub-response,
- communication type,
- next follow-up date,
- overdue status.

These are implementation extensions, not requirements explicitly stated by the SOP.

---

# 7. Follow-Up Result List

The SOP screenshots show the Follow-Up workspace containing a filter section followed by a tabular result area.

The result table is intended to let users identify leads requiring action.

A row should conceptually represent:

```text
Lead + Customer + Enquiry + Current Follow-Up State
```

The exact column set should be derived from the CRM's existing Lead/Enquiry model rather than duplicated independently in the Follow-Up module.

### Recommended logical columns

**Source-supported concepts:**

- lead/customer identification,
- category/project/enquiry context where available,
- current response/status,
- next follow-up date/time,
- assigned/owner information,
- follow-up/action controls.

**Implementation Recommendation:** The UI can expose additional columns if the existing CRM data model supports them, but the Follow-Up page should avoid becoming a second independent lead-management database.

---

# 8. Taking a Follow-Up

The core workflow is:

1. Select a lead.
2. Click **Follow Up**.
3. Open the follow-up form.
4. Enter/update the required interaction information.
5. Select a response.
6. Select a sub-response.
7. Set the next follow-up time.
8. Select communication type.
9. Add remarks.
10. Save.
11. Add the interaction to the lead's activity log.

The SOP explicitly states that the follow-up entry must appear in the lead's activity log.

---

# 9. Follow-Up Form

The form should capture the following conceptual data.

## 9.1 Additional Customer Details

The SOP gives examples such as:

- requirements,
- interests,
- other additional customer details.

These fields allow information learned during the interaction to be captured.

**Implementation Recommendation:** Where possible, these values should update the canonical customer/lead/enquiry record rather than creating duplicate customer attributes inside each follow-up.

---

## 9.2 Response

The user must select a **Response**.

Examples explicitly given by the SOP include:

- **Contacted**
- **Qualified**
- **Site Visit/Meeting**
- **Negotiation**

Response is a standardized classification of the interaction outcome.

This field is important for reporting and workflow consistency.

### Business rule

Users should not be encouraged to invent arbitrary free-text values when a standardized response is available.

The SOP explicitly requires standardized responses for consistency in reporting.

---

## 9.3 Sub-response

The user must choose a **Sub-response**.

The SOP establishes the existence of this hierarchical classification but does not define a universal list of sub-response values in the text.

Therefore:

> **Do not hard-code a specific sub-response catalogue solely from this SOP.**

The sub-response list should come from the CRM's configurable master data or an equivalent configuration layer.

---

## 9.4 Next Follow-Up Time

The user must set the **Next Follow-up Time**.

This is a key workflow field.

It represents when continued engagement should occur.

### Business rule

A lead that remains in the follow-up lifecycle should have a scheduled next action whenever continued engagement is required.

The SOP explicitly states:

> Leads should not remain idle beyond the scheduled follow-up time.

This means the system should be capable of identifying follow-ups that have become due or overdue.

**Implementation Recommendation:** Store the next follow-up as a proper date-time value rather than only as display text.

---

## 9.5 Communication Type

The user selects the communication channel/type.

The SOP explicitly gives examples:

- **Call**
- **Email**
- etc.

The exact complete catalogue is not specified.

The communication type should therefore be represented as configurable or extensible rather than assuming that only Call and Email exist.

---

## 9.6 Remarks

The user can add remarks describing the interaction.

Remarks are particularly important for:

- contextual information,
- future reference,
- explaining why a lead was dumped,
- documenting transfer context,
- preserving information that does not fit standardized fields.

The SOP specifically requires remarks for Dump and allows remarks in the normal follow-up form.

---

# 10. Saving a Follow-Up

When the user clicks **Save**:

1. The interaction should be persisted.
2. The follow-up should become part of the lead's history/activity log.
3. The lead's current follow-up state should reflect the selected response/disposition.
4. If a next follow-up time was specified, the lead should become actionable again at that time.
5. If the user selected a terminal disposition, the lead should leave the normal active follow-up queue.

The SOP explicitly requires the saved interaction to appear in the lead's activity log.

---

# 11. Activity Log

The Activity Log is the historical record of interactions associated with a lead.

Conceptually:

```text
Lead
 │
 ├── Follow-Up — Contacted — Call — 10:00
 ├── Follow-Up — Qualified — Call — 15:00
 ├── Follow-Up — Site Visit/Meeting — Meeting — 11:00
 └── Follow-Up — Negotiation — Call — 16:00
```

Each historical event should preserve what was known at the time of the interaction.

**Implementation Recommendation:** Follow-up records should be append-oriented. Editing a previous follow-up should not silently rewrite the historical sequence without an audit trail.

---

# 12. Disposition Actions

At the bottom of the follow-up interface, the SOP defines four disposition choices.

## 12.1 Followups

**Purpose:** Continue engagement.

This is the default path for a lead that remains active.

Expected behavior:

- preserve the lead as an active prospect,
- record the interaction,
- retain/assign the next follow-up time,
- keep the lead in the follow-up workflow.

---

## 12.2 Transfer

**Purpose:** Assign the lead to another team member or senior.

The SOP specifies:

1. Select Transfer.
2. Assign the lead to a different employee/senior.
3. The lead appears in the new owner's follow-up queue.
4. The lead reflects an updated date.

### Transfer data

At minimum, the system needs to know:

```text
Lead
Previous Owner
New Owner
Transfer Date/Time
```

**Implementation Recommendation:** Preserve the previous owner rather than overwriting history. This creates an auditable ownership transition.

The SOP does not specify whether a transfer reason is mandatory; therefore this should remain configurable unless defined elsewhere in the CRM.

---

## 12.3 Successful

**Purpose:** Mark the lead as converted because booking has been confirmed.

The SOP explicitly states:

- select Successful if the lead has confirmed booking,
- marking a lead successful moves it to the conversion list.

Therefore:

```text
Active Lead
   │
   ▼
Successful
   │
   ▼
Conversion List
```

### Business rule

**Successful must represent confirmed booking**, not merely a positive conversation or a qualified lead.

The SOP distinguishes interaction responses such as Qualified/Negotiation from the final Successful disposition.

---

## 12.4 Dump

**Purpose:** Close a lead that is no longer valid.

The SOP requires:

1. Select Dump.
2. Select a reason.
3. Add remarks for future reference.

### Dump data

```text
Lead
Dump Reason
Remarks
Dump Date/Time
```

The SOP screenshot shows a reason-selection control with multiple possible reasons, but the textual SOP does not provide a canonical complete list.

Therefore:

> The Dump Reason catalogue should be treated as configurable master data unless another authoritative source defines the exact values.

Dump is a terminal disposition from the active prospect workflow.

---

# 13. Status Model

There are two related concepts in the SOP that should not be conflated:

### A. Response / interaction status

Examples:

- Contacted
- Qualified
- Site Visit/Meeting
- Negotiation

These describe the outcome/stage of the interaction.

### B. Disposition

Examples:

- Followups
- Transfer
- Successful
- Dump

These determine what happens to the lead operationally.

A clean implementation should model these separately.

```text
Lead
 ├── Response / Sub-response
 │      └── Describes interaction outcome
 │
 └── Disposition
        ├── Followups
        ├── Transfer
        ├── Successful
        └── Dump
```

This separation prevents a value such as **Qualified** from being incorrectly treated as equivalent to **Successful**.

---

# 14. Recommended Data Model

The SOP does not define a database schema. The following is an implementation recommendation derived from the workflow.

## 14.1 Lead

```text
Lead
- id
- customer_id
- enquiry_id
- owner_id
- current_response
- current_sub_response
- current_disposition
- next_follow_up_at
- status_updated_at
- created_at
- updated_at
```

The exact existing Lead schema should be reused if the CRM already has one.

---

## 14.2 FollowUp

```text
FollowUp
- id
- lead_id
- owner_id
- response_id
- sub_response_id
- communication_type
- next_follow_up_at
- remarks
- interaction_at
- created_by
- created_at
```

### Important distinction

`interaction_at` and `next_follow_up_at` represent different concepts:

- **interaction_at:** when the current communication/activity happened,
- **next_follow_up_at:** when the next interaction is expected.

They should not be stored as the same field.

---

## 14.3 Transfer

```text
LeadTransfer
- id
- lead_id
- from_owner_id
- to_owner_id
- transferred_at
- remarks
- created_by
```

This is recommended for preserving ownership history.

---

## 14.4 Disposition

```text
LeadDisposition
- id
- lead_id
- disposition_type
- reason_id
- remarks
- created_by
- created_at
```

For example:

```text
disposition_type =
    FOLLOWUP
    TRANSFER
    SUCCESSFUL
    DUMP
```

A normalized disposition history is preferable to simply overwriting the lead's current status.

---

# 15. Master Data

Several fields in the SOP behave like controlled/master data:

- Response
- Sub-response
- Communication Type
- Dump Reason
- Transfer recipient/employee

The CRM should ideally maintain these through configuration rather than embedding lists directly in UI code.

Example:

```text
Response
   │
   ├── Contacted
   ├── Qualified
   ├── Site Visit/Meeting
   └── Negotiation

Sub-response
   └── Depends on configured response hierarchy
```

The SOP does not provide the complete values for these master lists, so those values must come from the existing CRM configuration or another authoritative business source.

---

# 16. UI Architecture

A practical Follow-Up page can be organized into four areas.

```text
┌─────────────────────────────────────────────────────────────┐
│ FOLLOW-UPS                                                   │
├─────────────────────────────────────────────────────────────┤
│ Search / Filters                                             │
│ [Status] [Owner] [Date] [Response] [Search] [Clear]         │
├─────────────────────────────────────────────────────────────┤
│ Lead Results                                                 │
│                                                             │
│ Lead | Customer | Response | Owner | Next Follow-up | Action│
│ ----------------------------------------------------------- │
│ ...                                                         │
├─────────────────────────────────────────────────────────────┤
│ Selected Lead / Follow-Up Form                               │
│                                                             │
│ Customer / Requirement Details                              │
│ Response | Sub-response | Communication Type               │
│ Next Follow-up Time | Remarks                               │
│                                                             │
│ [Followups] [Transfer] [Successful] [Dump]                  │
│                                                             │
│ [Save] [Close]                                              │
├─────────────────────────────────────────────────────────────┤
│ Activity / Follow-Up History                                 │
│                                                             │
│ Previous interactions and outcomes                          │
└─────────────────────────────────────────────────────────────┘
```

This layout is an implementation recommendation. The SOP establishes the existence of the search interface, follow-up form, disposition controls, and activity history, but does not prescribe a specific modern UI layout.

---

# 17. User Interaction Rules

## Selecting a Lead

The user selects a lead from the Follow-Up result set.

The system should load the lead's current context before allowing an interaction to be recorded.

## Starting a Follow-Up

The user clicks **Follow Up**.

The system opens the interaction form associated with that lead.

## Recording the Interaction

The user provides:

- customer details,
- response,
- sub-response,
- next follow-up time,
- communication type,
- remarks.

## Saving

Save creates a historical interaction and updates the active workflow state.

## Disposition

The user can choose:

- Followups,
- Transfer,
- Successful,
- Dump.

The system should apply the business effect associated with the selected action.

---

# 18. Validation Rules

The following validation rules are directly or strongly implied by the SOP.

### Rule 1 — Standardized response

Response should use a standardized value.

### Rule 2 — Next follow-up for continuing engagement

If the lead remains in Followups, a next follow-up time should normally be required.

### Rule 3 — Transfer requires a new owner

A Transfer action must identify the employee/senior who will receive the lead.

### Rule 4 — Successful represents confirmed booking

Successful should only be selected when booking is confirmed.

### Rule 5 — Dump requires reason and remarks

The SOP explicitly requires both a Dump reason and remarks.

### Rule 6 — Interaction history is retained

Saving a follow-up must add it to the lead's activity log.

### Rule 7 — Ownership changes are reflected in queue

After Transfer, the lead must appear in the new owner's follow-up queue.

### Rule 8 — Status must be updated after interaction

The SOP explicitly requires lead status to be updated after an interaction.

---

# 19. Queue and Due-Date Logic

The Follow-Up page is fundamentally date-driven.

A lead's next follow-up time determines when it needs attention.

Conceptually:

```text
next_follow_up_at > now
        │
        ▼
Scheduled / Upcoming

next_follow_up_at <= now
        │
        ▼
Due / Overdue
```

The SOP does not define exact labels for these states, so **Due** and **Overdue** are implementation terminology rather than source-defined statuses.

The important source-defined business rule is:

> A lead should not remain idle beyond its scheduled follow-up time.

Therefore the application should make overdue work visible and actionable.

**Implementation Recommendation:** Provide an overdue indicator, filter, or queue ordering so users can prioritize leads whose follow-up time has passed.

---

# 20. Ownership Logic

The Follow-Up queue should be owner-aware.

For an active lead:

```text
Lead → Current Owner → Owner's Follow-Up Queue
```

When transferred:

```text
Lead
 │
 ├── Previous Owner
 │
 └── New Owner
       │
       ▼
New Owner's Follow-Up Queue
```

The SOP explicitly requires the lead to reflect under the new owner's queue after transfer.

---

# 21. Conversion Logic

Successful is the conversion transition.

```text
Follow-Up Workflow
        │
        ▼
Confirmed Booking
        │
        ▼
Successful
        │
        ▼
Conversion List
```

The Follow-Up module should therefore integrate with the CRM's conversion/booking domain rather than merely changing a cosmetic status.

The SOP does not specify the fields required by the conversion list or booking module. Those should be defined by the existing CRM architecture.

---

# 22. Dump Logic

Dump is a controlled closure.

```text
Active Prospect
      │
      ▼
Dump
      │
      ├── Reason
      └── Remarks
      │
      ▼
No longer an active prospect
```

Dumped leads should remain retrievable for reporting and supervisor review.

The SOP explicitly requires weekly supervisor review of dumped leads.

Therefore Dump should not mean physical deletion.

**Implementation Recommendation:** Use a soft lifecycle state/history record rather than deleting the lead.

---

# 23. Transfer and Dump Review

The SOP requires weekly supervisor reviews to reassess:

- dumped leads,
- transferred leads.

This creates a management/review layer above the day-to-day follow-up workflow.

Conceptually:

```text
Daily Operations
       │
       ▼
Follow-Up / Transfer / Dump
       │
       ▼
Historical Records
       │
       ▼
Weekly Supervisor Review
```

The SOP does not define how supervisors perform the review, what UI they use, or whether a lead can be reopened. Those details require separate business rules.

---

# 24. Auditability

Although the SOP does not prescribe a technical audit schema, the workflow strongly benefits from preserving historical events.

Recommended event types:

```text
FOLLOW_UP_CREATED
RESPONSE_CHANGED
OWNER_TRANSFERRED
MARKED_SUCCESSFUL
MARKED_DUMPED
NEXT_FOLLOW_UP_SCHEDULED
```

An event history allows the CRM to answer:

- Who interacted with the lead?
- When?
- What response was selected?
- What communication type was used?
- What was the next follow-up time?
- Who owned the lead?
- When was it transferred?
- Why was it dumped?
- When was it marked successful?

These are implementation recommendations for traceability, not explicit SOP requirements.

---

# 25. API / Service Architecture

A clean backend architecture should separate Lead, Follow-Up, and Disposition responsibilities.

Example conceptual API:

```text
GET    /followups
GET    /leads/{leadId}
GET    /leads/{leadId}/followups

POST   /leads/{leadId}/followups
POST   /leads/{leadId}/transfer
POST   /leads/{leadId}/successful
POST   /leads/{leadId}/dump
```

The exact API naming is an implementation recommendation.

The key architectural principle is:

> Follow-up operations should operate on the canonical Lead entity and create historical Follow-Up/Disposition records rather than creating a disconnected copy of the lead.

---

# 26. Transaction Behavior

Disposition changes should be atomic.

For example, Transfer should conceptually perform:

```text
BEGIN
  validate lead
  validate new owner
  create transfer history
  update current owner
  update follow-up queue state
  update relevant dates/status
COMMIT
```

Successful should conceptually perform:

```text
BEGIN
  validate confirmed-booking condition
  create successful disposition history
  update lead lifecycle
  make lead available to conversion workflow
COMMIT
```

Dump should conceptually perform:

```text
BEGIN
  validate dump reason
  validate remarks
  create dump disposition history
  close active follow-up state
COMMIT
```

This prevents partial updates such as a transfer being recorded without the queue changing.

---

# 27. Permissions

The SOP does not define a detailed permission matrix.

However, the architecture should support at least these conceptual roles:

- **Lead/Follow-Up User:** manage assigned leads.
- **Senior/Manager:** receive transferred leads and review operational activity.
- **Supervisor:** perform weekly review of dumped and transferred leads.
- **Administrator:** manage master data and configuration.

These roles are implementation recommendations based on the responsibilities described in the SOP.

Do not assume that every role has every permission unless the CRM's authorization model explicitly grants it.

---

# 28. Reporting Requirements

The SOP's requirement for standardized responses indicates that follow-up data is intended to support reporting.

The system should be able to aggregate at least:

- response,
- sub-response,
- disposition,
- communication type,
- owner,
- follow-up date,
- transfer activity,
- successful conversions,
- dump reasons.

This enables operational questions such as:

```text
How many leads were contacted?
How many became qualified?
How many reached site visit/meeting?
How many entered negotiation?
How many were transferred?
How many were successful?
How many were dumped, and for what reasons?
Which leads are due for follow-up?
```

The SOP does not define specific report names or KPI formulas.

---

# 29. Source-of-Truth Rules

When implementing or extending the Follow-Up page, use these rules:

1. **Lead remains the central business entity.**
2. **Follow-Up records are historical interaction records.**
3. **Response and Sub-response classify the interaction.**
4. **Disposition determines the operational outcome.**
5. **Followups means continued engagement.**
6. **Transfer changes ownership and queue responsibility.**
7. **Successful means confirmed booking and moves the lead to conversion.**
8. **Dump closes an invalid/no-longer-prospect lead and requires reason + remarks.**
9. **Every saved follow-up must appear in the activity log.**
10. **Standardized responses must be used for consistent reporting.**
11. **Continuing leads require a scheduled next follow-up.**
12. **Overdue leads must not silently remain idle.**
13. **Transferred leads must appear in the new owner's queue.**
14. **Dumped and transferred leads require weekly supervisor review.**
15. **Do not delete historical follow-up/disposition records merely because the lead changes state.**

---

# 30. What the SOP Does Not Define

The following should **not** be invented and treated as established business rules from this document:

- exact database schema,
- exact API endpoints,
- exact response catalogue beyond examples,
- exact sub-response catalogue,
- exact communication-type catalogue,
- exact dump-reason catalogue,
- exact permissions,
- exact notification mechanism,
- exact reminder mechanism,
- exact overdue thresholds,
- exact queue sorting,
- exact UI framework/layout,
- exact reporting KPIs,
- exact conversion-list schema,
- lead reopening rules,
- deletion/retention period,
- integration with email/SMS/calling providers.

These require either existing CRM conventions or additional business requirements.

---

# 31. Recommended Implementation State Machine

For engineering purposes, the lifecycle can be represented as:

```text
                    ┌────────────────────┐
                    │   ACTIVE LEAD      │
                    └─────────┬──────────┘
                              │
                              ▼
                       ┌─────────────┐
                       │  FOLLOW-UP  │
                       └──────┬──────┘
                              │
           ┌──────────────────┼───────────────────┐
           │                  │                   │
           ▼                  ▼                   ▼
       FOLLOWUPS           TRANSFER           SUCCESSFUL
           │                  │                   │
           │                  ▼                   ▼
           │             New Owner          Conversion List
           │                  │
           │                  ▼
           │             Follow-Up Queue
           │
           ▼
     Next Follow-Up
           │
           └───────────────► FOLLOW-UP

           FOLLOW-UP
               │
               ▼
             DUMP
               │
               ▼
        Closed / Invalid
```

Important distinction:

- **Followups** is a continuing workflow.
- **Transfer** changes responsibility.
- **Successful** is a conversion outcome.
- **Dump** is a closure outcome.

---

# 32. Reference Workflow for an AI Developer

When an AI/LLM is asked to implement the Follow-Up page, it should reason through the following sequence:

```text
1. Identify the Lead entity.
2. Load its current customer and enquiry context.
3. Load its current owner.
4. Load its current response/sub-response.
5. Load its current disposition.
6. Load follow-up history.
7. Determine whether the lead has a scheduled next follow-up.
8. Display the lead in the Follow-Up queue if it belongs to the active workflow.
9. When Follow Up is selected:
   a. collect customer/requirement updates,
   b. collect Response,
   c. collect Sub-response,
   d. collect Next Follow-up Time,
   e. collect Communication Type,
   f. collect Remarks.
10. Save the interaction to the activity history.
11. Update the lead's current workflow state.
12. If Followups is selected, keep the lead active.
13. If Transfer is selected, assign a new owner and update the queue.
14. If Successful is selected, move the lead to conversion handling.
15. If Dump is selected, require reason + remarks and close active follow-up handling.
16. Preserve historical records.
17. Ensure due/overdue follow-ups remain visible.
18. Support supervisor review of transferred and dumped leads.
```

---

# 33. Definition of Done

The Follow-Up page should be considered functionally aligned with this SOP when a user can:

- [ ] Navigate to the Follow-Up workspace through the Lead/Enquiry workflow.
- [ ] Search/filter for leads.
- [ ] Select a lead.
- [ ] Open the Follow-Up form.
- [ ] Record customer requirements/interests.
- [ ] Select a standardized Response.
- [ ] Select a Sub-response.
- [ ] Set the next follow-up time.
- [ ] Select communication type.
- [ ] Add remarks.
- [ ] Save the interaction.
- [ ] See the interaction in the lead activity log.
- [ ] Continue the lead using Followups.
- [ ] Transfer the lead to another employee/senior.
- [ ] See the transferred lead in the new owner's follow-up queue.
- [ ] Mark a confirmed booking as Successful.
- [ ] Move Successful leads into the conversion workflow/list.
- [ ] Dump an invalid lead.
- [ ] Require a Dump reason and remarks.
- [ ] Retrieve dumped leads for review.
- [ ] Identify leads whose scheduled follow-up time has passed.
- [ ] Support supervisor review of dumped and transferred leads.
- [ ] Preserve the historical lifecycle of the lead.

---

# 34. Final Architectural Principle

The Follow-Up page should be implemented as a **workflow layer over the existing Lead/Enquiry model**, not as an independent lead database.

The central architecture is:

```text
                    ┌────────────────────┐
                    │       LEAD         │
                    │ Customer + Enquiry │
                    └─────────┬──────────┘
                              │
                ┌─────────────┼──────────────┐
                │             │              │
                ▼             ▼              ▼
          Follow-Up       Disposition      Ownership
          History          History          History
                │             │              │
                └─────────────┼──────────────┘
                              │
                              ▼
                    Follow-Up Workspace
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
         Continue          Transfer        Terminal
         Follow-Up                         Outcome
                                              │
                                  ┌───────────┴───────────┐
                                  ▼                       ▼
                              Successful                Dump
                                  │                       │
                                  ▼                       ▼
                            Conversion List          Closed/Invalid
```

The most important implementation rule is to preserve the distinction between **interaction history**, **current lead state**, and **final disposition**. This allows the CRM to maintain a reliable chronological activity log while still providing a fast operational queue for today's follow-up work.

---

## Source Reference

This specification is based on the supplied **SOP: LeadSync – Lead Follow-up and Disposition Management**, which defines the Follow-Up objective, navigation path, search workflow, follow-up fields, disposition actions, lifecycle summary, and compliance requirements. The source explicitly requires timely/structured follow-up, standardized responses, activity logging, transfer behavior, successful conversion behavior, dump reasons/remarks, and weekly review of dumped and transferred leads.
