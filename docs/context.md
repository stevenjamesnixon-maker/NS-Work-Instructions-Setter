# Work Instructions — project context

Canonical reference for this project. If this document and the repository disagree, **the
repository wins** — read the file and then fix this document in the same PR.

Scope of this document: the SuiteScript in this repo and the NetSuite configuration it depends
on. It does not describe the wider NetSuite account.

---

## 0. Read this first

Five traps that will catch a new session before it touches anything. Each of these has already
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
| _(none yet)_ | — | — | — | Populated from Phase 2 |

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

**Work Instruction Type** — custom record, configured in NetSuite, **not in this repo.**
The configuration table. One record per work instruction, holding:
- the custom form internal ID to open the Task on
- the default assignee
- the assignment source
- the default priority
- the due date offset, in days

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
5. Verify the assignee matches the configured default or assignment source.
6. Grep the execution log for `WI_` and confirm no `WI_CONFIG_MISSING` or `WI_ROUTE_FAILED`.

---

## 10. Open items

### NetSuite IDs to confirm before Phase 2

No script file can be written until these are filled in. Script IDs only — **no internal IDs in
this table.**

| Item | Script ID | Confirmed by | Date |
|---|---|---|---|
| Work Instruction Type custom record | | | |
| Task field holding the work instruction | | | |
| Config field: custom form internal ID | | | |
| Config field: default assignee | | | |
| Config field: assignment source | | | |
| Config field: default priority | | | |
| Config field: due date offset (days) | | | |
| Task field holding the sourced offset, if one exists | | | |

### Unresolved questions

| # | Question | Status |
|---|---|---|
| 1 | Button on Opportunity only, or Customer as well? | Unresolved |
| 2 | Does the picker let the user override assignee and priority, or set them silently? | Unresolved |
| 3 | Does a workflow remain in the account as a server-side safety net? | Unresolved |
