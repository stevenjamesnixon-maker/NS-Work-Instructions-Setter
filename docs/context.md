# Work Instructions — project context

Canonical reference for this project. If this document and the repository disagree, **the
repository wins** — read the file and then fix this document in the same PR.

Scope of this document: the SuiteScript in this repo and the NetSuite configuration it depends
on. It does not describe the wider NetSuite account.

---

## 0. Read this first

Six traps that will catch a new session before it touches anything. Each of these has already
cost time on this project.

1. **`customform` is not searchable and cannot be set by a workflow.**
   NetSuite does not expose the Custom Form field to saved searches on the Task record, and
   SuiteFlow's Set Field Value does not reliably write it. Do not attempt either. Several days
   were lost to this. Reporting on "which kind of work is this" must therefore key on a real
   custom field, not on the form.

2. **Never switch the custom form on an already-rendered record.**
   Changing the form on a loaded record reloads the page and clears custom field values set
   moments earlier — including the work instruction field itself, which then takes its sourced
   values down with it. This is the specific failure this project exists to design around.
   **The form is chosen _before_ the Task record is created, never after.**

3. **Script IDs vs internal IDs.** See section 3. Committing an internal ID is the one mistake
   that breaks this repo across environments.

4. **List fields return raw stored values, not display names.**
   Any comparison keyed on a list field must normalise first, or it will work for some records
   and silently fail for others. Do not compare against the text a user sees in the UI.

5. **Field IDs are used exactly as they exist in the account, typos included.**
   If an ID has a missing letter or a doubled prefix, that is the ID. Never "correct" one — the
   corrected version does not exist and the failure is silent.

6. **`custrecord_wi_default_form_type` is deprecated. Do not use it.**
   The field exists in the account and its name makes it look like the right source of the custom
   form. It is not. It is mis-built — a List/Record pointing at the Task record type rather than
   holding a form — and it is being made inactive. **The form comes from
   `custrecord_wi_form_internal_id`.** This is written down so that a future session does not
   discover the field and switch to it.

---

## 1. What this solves

Work is passed between teams — sales, design, customer advisors and field engineers — as
NetSuite Tasks raised against an Opportunity or Customer. Each type of work (a "work
instruction") needs its own Task form, its own assignee, and its own due date.

Two problems drove this build.

**Reporting was impossible.** NetSuite will not let saved searches see which custom form a Task
uses, so workload could not be reported on at all — there was no way to ask "how many design
instructions are open".

**Choosing the work instruction broke the record.** There is no native way to pick a work
instruction and have the right form appear. Attempts to switch the form after the record had
loaded cleared the field that identified the work instruction, which in turn broke every value
sourced from it.

The solution chooses the work instruction **before the Task exists**. A button on the
Opportunity or Customer opens a picker; the picker reads a configuration record; the Task then
opens on the correct form with its type, assignee, priority and due date already set. The user
completes the type-specific fields and saves.

Because the work instruction type is written to a real custom field rather than implied by the
form, it is searchable.

---

## 2. Components and versions

> This table is **indicative**. Version tables drift. Read the `VERSION` constant and the JSDoc
> `@version` header in the file itself to confirm what is actually deployed.

| Component | Version | File | Purpose | Status |
|---|---|---|---|---|
| Shared config library | 1.0.0 | `src/FileCabinet/SuiteScripts/WorkInstructions/lib/wi_lib_config.js` | Confirmed script IDs for the config record and the Task field. Constants only so far. | Not deployed |
| Button user event | — | — | "Create Work Instruction" button | Not written |
| Picker Suitelet | — | — | Choose work instruction, open Task on correct form | Not written |
| Task user event | — | — | `beforeLoad` value application and safety net | Not written |

Versioning convention: semver. Each script carries a `VERSION` constant and a JSDoc `@version`
header, and the two are kept in step with each other and with this table.

---

## 3. Environments — environment-agnostic policy

**This repo represents no single environment.** The same files must deploy unchanged to Sandbox
and to Production.

That is only possible because of this distinction:

| Committable | Never committable |
|---|---|
| Script IDs — `customrecord_*`, `custevent_*`, `custrecord_*`, `customlist_*`, `customscript_*`, `customdeploy_*` | Internal IDs — numeric record IDs, custom form IDs, File Cabinet folder IDs |
| File Cabinet **paths** | File Cabinet folder **internal IDs** |
| Field and record script IDs | Account numbers, account-specific URLs |

Script IDs are chosen by the developer and are identical in both environments. Internal IDs are
assigned by NetSuite per account and differ between them.

**Every numeric ID this feature needs** — the custom form to open, who to assign to, how many
days until due — **is stored on the Work Instruction Type custom record in NetSuite, not in
code.** Adding a new work instruction is a data entry job in NetSuite, not a code change and not
a deployment.

Numeric internal IDs will legitimately appear in URLs built at runtime, because they were read
from the configuration record a moment earlier. That is fine. What must never happen is a
numeric ID appearing as a literal in a committed file.

Use `url.resolveScript()` for any Suitelet URL. Never hand-build one — a hand-built URL embeds
account-specific host names and script internal IDs.

---

## 4. Architecture

Four moving parts, plus the configuration record that drives all of them.

**Work Instruction Type** — custom record `customrecord_wi_config`, configured in NetSuite,
**not in this repo.** The configuration table. One record per work instruction, holding:

| Holds | Field | Type |
|---|---|---|
| Custom form internal ID to open the Task on | `custrecord_wi_form_internal_id` | Integer |
| Default assignee | `custrecord_wi_default_assignee` | List/Record → Employee |
| Default priority | `custrecord_wi_default_priority` | List |
| Due date offset, in days | `custrecord_wi_due_date_offset` | Integer |

There is **no assignment source field** and none will be created. The assignee rule is, in order:

1. Use **Default Assignee** if it is populated.
2. Otherwise use the **sales rep from the source record**.
3. Otherwise leave **Assigned To** empty.

The **priority** rule: normalise the raw stored value — trim and uppercase — and map it to
NetSuite's native Task priority values `HIGH`, `MEDIUM`, `LOW`. **If it does not map, leave
priority unset and log the raw value at audit level rather than guessing.**

> **Unresolved — see section 10.** Whether trim-and-uppercase is the correct normalisation
> depends on what kind of list `custrecord_wi_default_priority` is. If it sources from NetSuite's
> native Task Priority list, the stored values genuinely are `HIGH`/`MEDIUM`/`LOW` and the rule is
> right. If it is a hand-built custom list, `getValue()` returns a **numeric internal ID** and the
> rule would never match. Do not implement the mapping until this is confirmed.

**Button user event** — on Opportunity (and Customer, to be confirmed — see section 10).
Adds a "Create Work Instruction" button on view. The button opens the picker Suitelet, passing
the originating record so the Task can be linked back to it.

**Picker Suitelet** — lists the active Work Instruction Type records, collects priority and
instruction notes from the user, then opens a new Task **on the correct form** with values
pre-applied. This is where the form is chosen, and it is the only place the choice can safely be
made, because at this point the Task does not yet exist.

**Task user event (`beforeLoad`)** — applies values that cannot travel in a URL, and derives the
work instruction type from the form as a safety net, so that a Task created by any other route
still carries a searchable type. Runs before the page renders, so it does not trip trap 2.

**Shared config library** — the only module that reads the Work Instruction Type record. Every
other script goes through it. One place to change when the configuration record changes; one
place to look when a lookup misbehaves.

### The constraint that shapes every future change

**Nothing may set the custom form after the Task page has rendered.** Any proposed change that
involves switching the form on a loaded record is wrong, however reasonable it looks. Route it
through the pre-creation path instead.

---

## 5. Standing warnings

- **`log.warn()` does not exist in SuiteScript.** Use `log.debug()`. Calling `log.warn()` throws.
- **`search.lookupFields()` fails on computed fields.** Use `record.load().getValue()` for
  anything derived, formula-based or summary.
- **SuiteFlow formulas cannot reliably join through a List/Record field into a custom record**,
  and client-side formula evaluation is limited. This is why the routing logic here is scripted
  rather than built as a workflow.
- **A workflow may still exist in the account** as a server-side safety net for Tasks created
  outside this feature. If one does, it is recorded under section 10. Note that such a workflow
  cannot set the custom form (trap 1) — at most it can populate the work instruction field.

---

## 6. Known issues and limitations

Nothing recorded yet. Add entries here as they are found, with the date and the script version
they were observed on.

---

## 7. Audit log keys

Every `log.audit` and `log.error` title begins `WI_`, so the execution log can be filtered on one
string.

| Key | Meaning | What to do if it fires |
|---|---|---|
| `WI_TASK_CREATED` | A Task was created through the picker. Normal operation. | Nothing. Confirms the happy path. |
| `WI_CONFIG_MISSING` | A Work Instruction Type record could not be read, or a required field on it was empty. | Check the configuration record exists in this account and is fully populated. See section 10. |
| `WI_ROUTE_FAILED` | The work instruction could not be routed — form, assignee or due date could not be resolved. | Read the logged raw values. Usually a configuration gap rather than a code fault. |
| `WI_PRIORITY_UNMAPPED` | The raw value of `custrecord_wi_default_priority` did not map to `HIGH`, `MEDIUM` or `LOW`. Priority was left unset — deliberately, not silently. | Read the logged raw value. Either the config record holds an unexpected option, or the normalisation rule is wrong. See section 4. |

Populate further keys as scripts are written. Log the **raw value** alongside every one of these,
so a mismatch is visible in the execution log rather than silently doing nothing.

---

## 8. Deployment sequence

Deployment is **manual File Cabinet upload**. There is no SDF project and no automated deploy.
**Steve deploys. Neither Claude deploys.**

1. **Upload `lib/wi_lib_config.js` to the File Cabinet first.** Every other script imports it by
   relative path and they all fail *at load time* if it is absent — the failure looks like a
   broken script record, not a missing file.
2. Upload the entry-point scripts.
3. Create or update the script records and deployments in the NetSuite UI.
4. Confirm the Work Instruction Type records exist and are populated **in the target account**.
   They are data, so they do not travel with the code.

Shared AMD modules need no script record and no deployment record — a File Cabinet upload is
sufficient. But **all files must sit in the same folder tree**, because the imports are relative
paths. The repo layout under `src/FileCabinet/` mirrors the File Cabinet exactly for this reason.

---

## 9. Testing

Manual, in Sandbox. There is no test framework in this repo and SuiteScript cannot be meaningfully
executed outside NetSuite.

Standard pass:

1. Create a work instruction from the button on **at least two different records**, covering more
   than one work instruction type.
2. Create a Task the ordinary way, **without** the button.
3. Verify the work instruction field is populated **and searchable** in both cases — build a saved
   search on it and confirm the record appears.
4. Verify the due date matches the configured offset.
5. Verify the assignee follows the section 4 rule: default assignee if populated, otherwise the
   sales rep from the source record, otherwise empty. **Test all three branches** — a config
   record with a default assignee, one without, and one whose source record has no sales rep.
6. Verify the priority maps correctly, and that a config record holding an unmappable priority
   leaves priority unset and raises `WI_PRIORITY_UNMAPPED` with the raw value.
7. Grep the execution log for `WI_` and confirm no `WI_CONFIG_MISSING`, `WI_ROUTE_FAILED` or
   unexpected `WI_PRIORITY_UNMAPPED`.

---

## 10. Open items

### NetSuite IDs to confirm before Phase 2

No script file can be written until these are filled in. Script IDs only — **no internal IDs in
this table.**

| Item | Script ID | Type | Confirmed by | Date |
|---|---|---|---|---|
| Work Instruction config custom record | `customrecord_wi_config` | Custom record | Steve | 2026-08-20 |
| Task field holding the work instruction | `custevent_work_instruction_type` | List/Record → config record | Steve | 2026-08-20 |
| Config field: custom form internal ID | `custrecord_wi_form_internal_id` | Integer | Steve | 2026-08-20 |
| Config field: default assignee | `custrecord_wi_default_assignee` | List/Record → Employee | Steve | 2026-08-20 |
| Config field: default priority | `custrecord_wi_default_priority` | List | Steve | 2026-08-20 |
| Config field: due date offset (days) | `custrecord_wi_due_date_offset` | Integer | Steve | 2026-08-20 |
| Task field holding the sourced offset | **Not provided** — see question 6 below | — | — | — |

**Withdrawn:** *Config field: assignment source.* No such field exists and none will be created.
The assignee rule in section 4 replaces it. Do not reintroduce it.

**Deprecated:** `custrecord_wi_default_form_type` — mis-built, being made inactive, must not be
read. See trap 6 in section 0.

### Unresolved questions

| # | Question | Status |
|---|---|---|
| 1 | Button on Opportunity only, or Customer as well? | Unresolved |
| 2 | Does the picker let the user override assignee and priority, or set them silently? | Unresolved |
| 3 | Does a workflow remain in the account as a server-side safety net? If so, does it write the same field as the Task `beforeLoad`, and which wins? | Unresolved |
| 4 | Is `custrecord_wi_default_priority` sourced from the native Task Priority list, or is it a hand-built custom list? This decides whether trim-and-uppercase normalisation works at all. **Blocks the priority logic.** | Unresolved |
| 5 | "Sales rep from the source record" — which record, and which field? On an Opportunity, is it the Opportunity's own sales rep or the customer's? Depends on question 1. | Unresolved |
| 6 | Is there a Task field holding the sourced due date offset, or is the due date calculated and written directly? | Unresolved |
| 7 | Which Task field links back to the originating Opportunity or Customer? | Unresolved |
| 8 | Which roles see the button and may run the picker Suitelet? | Unresolved |
