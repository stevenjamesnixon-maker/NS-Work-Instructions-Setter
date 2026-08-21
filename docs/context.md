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
| Shared config library | 1.4.0 | `lib/wi_lib_config.js` | All script IDs, plus the only reads of `customrecord_wi_config` | Not deployed |
| Source button user event | 1.1.0 | `wi_ue_source_button.js` | "Create Work Instruction" button on Opportunity and Customer | Not deployed |
| Source button client script | 1.0.0 | `wi_cs_source_button.js` | Handles the button click. Required — see section 5 | Not deployed |
| Picker Suitelet | 1.0.0 | `wi_sl_picker.js` | Choose the work instruction, open a Task on its form | Not deployed |
| Task prefill user event | 1.2.0 | `wi_ue_task_prefill.js` | Four-path prefill and recovery; `beforeSubmit` save-time recovery and type-change logging | Not deployed |

All paths are relative to `src/FileCabinet/SuiteScripts/WorkInstructions/`.

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

**Read the priority as TEXT — `getText()`, never `getValue()`.** The field's underlying type was
never definitively established: it may be a List/Record sourced from the native Task Priority list,
or a hand-built custom list. **Text was chosen deliberately because it is correct either way** —
both display *High* / *Medium* / *Low*. Mapping on option internal IDs would be wrong, because for
a custom list those are environment-specific and would break in a second account.

If the text does not map, `WI_PRIORITY_UNMAPPED` logs **both** the raw `getText()` and the raw
`getValue()`. If the assumption above is ever wrong, that log line names the exact value that
failed.

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

### Deliberate decisions — do not silently reverse these

| Decision | Why |
|---|---|
| **ES5 style throughout** — `var`, `function`, `'use strict'` | House convention for consistency. Not a limitation of SuiteScript 2.1. Do not modernise it. |
| **The work instruction field is written by `wi_ue_task_prefill.js` only** | Never via the picker URL. Exactly one writer, so there is never a question of which value wins. |
| **Task title is the config record name**, with no customer or record number | Provisional. Steve will refine it once he has seen it in use. |
| **Priority is read as text, not as an internal ID** | See section 0 trap 4 and the note under the priority rule above. |
| **Offset `0` means today** and is tested for explicitly, never by truthiness | `0` is falsy in JavaScript. An `if (offset)` check would silently skip the due date on exactly the records that want today. |
| **No caching in the config library** | One search per page load is trivial governance, and a cache would risk serving a stale form ID straight after someone edits a config record. Left out deliberately, not forgotten. |
| **`getByTypeId()` throws rather than returning null** | A missing config is always a defect — the id came from a link this feature generated. A swallowed null would produce a Task with no work instruction type, which is the exact outcome this feature exists to prevent. |
| **`getByTypeId()` does not filter on `isinactive`** | A user may open the picker moments before a config record is deactivated. Honouring the in-flight Task beats failing it. |

### The constraint that shapes every future change

**Nothing may set the custom form after the Task page has rendered.** Any proposed change that
involves switching the form on a loaded record is wrong, however reasonable it looks. Route it
through the pre-creation path instead.

---

## 5. Standing warnings

- **`form.addButton({ functionName: ... })` takes a function NAME, never an expression.**
  NetSuite appends `()` to whatever string it is given and invokes the result. An inline expression
  is therefore evaluated first, and its *result* is then called. Passing
  `"window.location.href='" + url + "'"` produced this in the Sandbox console:

  ```
  Uncaught TypeError: "/app/site/hosting/scriptlet.nl?script=3924&deploy=1&compid=472052
  &wi_src_type=opportunity&wi_src_id=17063730" is not a function
  ```

  The URL was intact and correctly escaped — the expression evaluated to the URL string, NetSuite
  appended `()`, and the string was called as a function. **The symptom is a `TypeError` naming the
  evaluated expression, not a silent failure**, so the console names the problem precisely.

  The fix: pass the bare name with **no parentheses** — NetSuite adds them, so
  `'openWorkInstructionPicker()'` would produce `openWorkInstructionPicker()()`. The name must
  match a key on the object returned by the client script **exactly, including case**. It is held
  once as `CLIENT_FUNCTIONS.OPEN_PICKER` in `wi_lib_config.js` so the two cannot drift.

  Anything the handler needs — here the resolved Suitelet URL — travels in a hidden form field,
  not in the button wiring.

- **Popup and tab behaviour is deliberate, and each rule exists for a reason:**
  - **The popup closes only when `window.opener` exists.** The picker can legitimately be opened
    directly by URL, and is opened that way whenever a popup was blocked. In those cases it is an
    ordinary tab, and closing it would shut the user's own tab under them.
  - **The Task is opened before the popup is closed**, never after. Closing the window first can
    cancel the pending navigation in some browsers.
  - **A blocked popup degrades to in-place navigation**, which is the pre-1.1.0 behaviour. A
    blocked popup must degrade to the old experience, never to a dead button.
  - **The Task opens at full tab width, not inside the popup.** A NetSuite Task form in a 520px
    window is unusable. The picker is a chooser, not a workspace.

- **Verified in Sandbox, 2026-08-20 — do not re-litigate these:**
  - `url.resolveTaskLink({ id: 'EDIT_TASK' })` **works.** Tasks open on the correct form. It is the
    right way to get a new-Task URL; there is no `N/url` call that builds one from a record type.
  - **The hidden picker URL field is readable in view mode.** The button could not have navigated
    otherwise. The `custpage` hidden-field pattern is sound here.

- **The four prefill paths, and what each one is allowed to touch:**

  | Path | Trigger | Type | Priority / due date / assignee | Company / transaction |
  |---|---|---|---|---|
  | **1 — picker** | `beforeLoad` CREATE, config id parameter present | From the parameter | From the config | From the source record |
  | **2 — form recovery** | `beforeLoad` CREATE, no parameter, form maps to one config | From the form, **always** | Re-applied in full if the type **changed** on this load; otherwise only the empty ones | Untouched |
  | **3 — save-time recovery** | `beforeSubmit` **CREATE only**, type still empty | From the form | Only the empty ones | Untouched |
  | **4 — no match** | Any | Untouched | Untouched | Untouched |

- **The form is authoritative on path 2.** Change the form, and the type and the derived values
  follow it. An only-when-empty rule on the type would leave it naming the form the user just
  abandoned.

- **Switching forms mid-create overwrites values the user may have typed.** Accepted deliberately:
  those values were derived from the previous configuration and are stale the moment the type
  moves — leaving one queue's assignee on another queue's work is exactly the mis-routing this
  exists to fix. The path is rare, the result is coherent, and every field is re-editable on the
  page in front of the user.

- **Save-time recovery is CREATE only**, never EDIT. On EDIT it would search the configuration
  record on every Task edit in the account where the type happens to be blank, and would stamp
  values onto an old Task somebody opened for an unrelated reason. Backfilling history is a
  deliberate one-off job, not a side effect of someone fixing a typo. XEDIT is excluded regardless:
  `newRecord` is sparse on inline edit and `customform` may not be present.

- **A negative due date offset is treated as unset**, and logged as `WI_OFFSET_INVALID`. A due date
  in the past is never what anyone meant, and applying it silently produces a Task that is overdue
  the moment it is created — which reads as a bug in this feature rather than an error in the
  configuration.

- **The form-to-type safety net is deliberate in four ways:**
  - **An ambiguous form mapping yields `null`, never a guess.** If two active config records claim
    the same form internal ID, the type is left blank and `WI_FORM_AMBIGUOUS` names both. Stamping
    a wrong type silently corrupts the reports this feature exists to produce, and nobody would
    know to look. A visible gap beats invisible wrong data.
  - **The reverse lookup sets ONLY the type field.** A hand-created Task has already had its due
    date, assignee and priority set by whoever created it. Overwriting them would be destructive.
  - **`WI_FORM_UNMAPPED` logs at debug, not error.** Volume, not indifference — most Tasks in the
    account have nothing to do with this feature, and an error line on each would bury real
    problems.
  - **Type changes are logged, not blocked.** The field is Inline Text on the forms, so any change
    comes from inline edit, CSV or a script. Blocking would turn a visible, investigable event into
    a support ticket about a Task that will not save.

- **`log.warn()` does not exist in SuiteScript.** Use `log.debug()`. Calling `log.warn()` throws.
- **`search.lookupFields()` fails on computed fields.** Use `record.load().getValue()` for
  anything derived, formula-based or summary.
- **SuiteFlow formulas cannot reliably join through a List/Record field into a custom record**,
  and client-side formula evaluation is limited. This is why the routing logic here is scripted
  rather than built as a workflow.
- **The workflow has been retired.** A SuiteFlow workflow previously attempted this routing and is
  being deleted from the account. It failed for two reasons: SuiteFlow could not reliably set the
  custom form, and client-side formula evaluation could not do the due date arithmetic. **Nothing
  in NetSuite other than these scripts writes the work instruction field.** There is no second
  writer and no ordering question. Do not reintroduce a workflow for this.

---

## 6. Known issues and limitations

| Item | Detail |
|---|---|
| **Suitelet access does not imply Task create permission** | Both the button user event and the picker Suitelet deploy to **All Roles**. A role without the Tasks permission will reach the picker, choose a work instruction, and then **fail at the Task itself**. The picker cannot detect this in advance. If users report "the picker works but the Task will not open", check their role's Tasks permission before looking at this code. |
| **CSV imports and integrations are covered only conditionally** | Save-time recovery runs in `beforeSubmit`, which CSV import fires **only when "Run Server SuiteScript and Trigger Workflows" is ticked on the import**. Untick it and nothing runs — no type, no prefill, no log. The same applies to any integration that suppresses user events. This is a NetSuite setting on each import, not something the scripts can detect or force. |
| **`priority` can never be seen as empty** | NetSuite defaults a new Task to Medium, and nothing can tell that default apart from a user who chose Medium. So the only-when-empty rule never applies to priority: on path 2 it is set when the type changes (`force`), and on **path 3 it is effectively never set at all**. A CSV-imported Task therefore gets its type, due date and assignee but keeps whatever priority the import gave it. |
| **Switching away to an unmapped form leaves a stale type** | Change the form from a work instruction form to one that maps to no config record, and path 4 touches nothing — so the previously derived type stays in place and now disagrees with the form. Clearing it would be destructive in other scenarios, so it is left alone and logged at debug. Worth knowing about; not worth code to prevent. |
| **Historical Tasks are not backfilled** | Recovery runs on create only. Tasks that already exist without a type keep none until something else fills them in. See section 10. |

Add further entries as they are found, with the date and the script version they were observed on.

---

## 7. Audit log keys

Every `log.audit` and `log.error` title begins `WI_`, so the execution log can be filtered on one
string.

> **Not every key reaches the Script Execution Log.** `wi_cs_source_button.js` is attached via
> `clientScriptModulePath` and therefore has **no script record and no deployment**, so it has
> nothing to log against. Its `N/log` output goes to the **browser console only** — the keys marked
> *console* below will never appear in the Script Execution Log, no matter how long you search for
> them. Keep the browser console open when testing anything client-side.

| Key | Meaning | What to do if it fires |
|---|---|---|
| `WI_TASK_CREATED` | **Reserved — no script raises this.** A Task is created when the user saves the form, which nothing in this feature observes. Kept only so that a future session grepping for it finds this note rather than hunting for a missing logger. | Nothing. |
| `WI_ASSIGNEE_RULE` | Records which of the three assignee branches was taken, with the raw config value and the raw source sales rep. Normal operation. | Nothing. Use it to confirm the rule behaved as expected. |
| `WI_CONFIG_INCOMPLETE` | A config record is unusable in part: no form internal ID (excluded from the picker), or a non-numeric due date offset (due date left alone). | Populate the missing value on the named config record. |
| `WI_PICKER_FAILED` | The picker Suitelet could not build its list. The user saw an apology, not an empty list. | Read the logged error. The picker never falls through to a default form. |
| `WI_PREFILL_FAILED` | The Task prefill threw. The Task form still opened, unpopulated or partly populated. | Read the logged parameters. The user can complete the Task by hand meanwhile. |
| `WI_BUTTON_FAILED` | The button could not be drawn on an Opportunity or Customer. The record still opened. | Read the logged error. Users cannot raise work instructions from that record until fixed. |
| `WI_BUTTON_URL_MISSING` | **Console only.** The button was clicked but the hidden picker URL field was empty. The user saw an apology rather than a blank page. | The user event drew the button but not the field. Check `beforeLoad` completed — a `WI_BUTTON_FAILED` entry in the Script Execution Log usually precedes this. |
| `WI_BUTTON_CLICK_FAILED` | **Console only.** The client-side button handler threw. | Read the browser console. |
| `WI_PREFILL_PATH` | Which of the three precedence paths a new Task took: 1 raised through the picker, 2 recovered from the form, 3 nothing to do. Normal operation. | Nothing. Use it to confirm the safety net is reaching the Tasks you expect. |
| `WI_OFFSET_INVALID` | A config record's due date offset is **negative**. Treated as unset; the due date was left alone. | Correct the named configuration record. Until then, Tasks of that type are created with no due date. |
| `WI_FORM_AMBIGUOUS` | **Error.** Two or more active config records claim the same form internal ID. The type was left blank rather than guessed. | Named in the log entry. Deactivate or repoint all but one, then fix the affected Tasks. Until then every Task on that form is created without a type. |
| `WI_FORM_UNMAPPED` | **Debug, deliberately.** A Task's form maps to no single active config record. Nothing was set. Expected on most Tasks in the account. | Nothing, normally. Only investigate if it appears for a form you believe *is* configured. |
| `WI_TYPE_CHANGED` | The work instruction type on a saved Task was changed away from an existing value. Records old value, new value, Task id and acting user. **The change was not blocked.** | Investigate if unexpected. The field is Inline Text on the forms, so the change came from inline edit, CSV or a script. |
| `WI_BEFORE_SUBMIT_FAILED` | `beforeSubmit` threw — either save-time recovery or the type-change logger. The Task still saved. | Read the logged error. Neither recovery nor logging may stop a Task saving. |
| `WI_POPUP_BLOCKED` | **Console only.** The browser blocked the picker popup, so it opened in place instead. Not a fault — the feature still works, but the user is navigated away from the source record. | Nothing required. If users hit it often, have them allow popups for the NetSuite domain. |
| `WI_CONFIG_MISSING` | A Work Instruction Type record could not be read, or a required field on it was empty. | Check the configuration record exists in this account and is fully populated. See section 10. |
| `WI_ROUTE_FAILED` | **Reserved — no script raises this.** It was specified before the code existed; the failures it described are now reported more precisely by `WI_CONFIG_MISSING`, `WI_CONFIG_INCOMPLETE`, `WI_FORM_AMBIGUOUS` and `WI_PREFILL_FAILED`. Kept only so a future session grepping for it finds this note rather than hunting for a missing logger. | Nothing. Search the four keys above instead. |
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
2. Upload the entry-point scripts: `wi_ue_source_button.js`, `wi_cs_source_button.js`,
   `wi_sl_picker.js` and `wi_ue_task_prefill.js`. **All four must sit in the same folder as each
   other**, with `lib/` beneath them — the imports and `clientScriptModulePath` are relative paths.
3. Create or update the script records and deployments in the NetSuite UI:

   | Script | Script ID | Deployments |
   |---|---|---|
   | `wi_sl_picker.js` | `customscript_wi_sl_picker` | `customdeploy_wi_sl_picker`. **Available Without Login: No.** |
   | `wi_ue_source_button.js` | `customscript_wi_ue_source_button` | **Two deployments from one script record** — Opportunity and Customer |
   | `wi_ue_task_prefill.js` | `customscript_wi_ue_task_prefill` | One deployment, Task. **Both `beforeLoad` and `beforeSubmit` are entry points from 1.1.0** — no extra deployment, but the script record must not restrict which functions run |
   | `wi_cs_source_button.js` | — | **None.** Attached by the user event via `clientScriptModulePath`. Upload only — creating a script record for it is wrong |

   The picker's script and deployment IDs are referenced by `url.resolveScript()` in
   `wi_ue_source_button.js`. **They must match `SCRIPT_IDS` in `wi_lib_config.js` exactly** or the
   button will throw when it builds its URL.
4. Confirm the Work Instruction Configuration records exist and are populated **in the target
   account**. They are data, so they do not travel with the code.
5. Set the deployment audiences:

   | Deployment | Audience |
   |---|---|
   | `wi_ue_source_button.js` (both deployments) | **All Roles** |
   | `wi_sl_picker.js` | **All Roles**, and **Available Without Login: No** |

   All Roles is deliberate. Note the limitation in section 6: reaching the picker does not grant
   permission to create a Task.

Shared AMD modules need no script record and no deployment record — a File Cabinet upload is
sufficient. But **all files must sit in the same folder tree**, because the imports are relative
paths. The repo layout under `src/FileCabinet/` mirrors the File Cabinet exactly for this reason.

---

## 9. Testing

Manual, in Sandbox. There is no test framework in this repo and SuiteScript cannot be meaningfully
executed outside NetSuite. Mechanical checks only were run before commit — syntax, headers,
versions, and greps for forbidden patterns.

Grep the execution log for `WI_` after every scenario.

> **Keep the browser console open for every client-side test.** `wi_cs_source_button.js` and the
> picker's injected click handler log to the console and nowhere else — see the note in section 7.
> A client-side failure searched for only in the Script Execution Log will look like silence.

| # | Scenario | Expected |
|---|---|---|
| 1 | Open an **Opportunity** in view mode | "Create Work Instruction" button present |
| 1a | **Click the button with the browser console open** | Picker opens **in a popup**. **No `TypeError`.** This is the regression that produced the error quoted in section 5 |
| 1b | Inspect the page source for the hidden URL field | Present and populated. If empty, the client script alerts rather than navigating to nowhere — see `WI_BUTTON_URL_MISSING` |
| 1c | After the popup opens, look at the **original tab** | The Opportunity is **still loaded and untouched** |
| 1d | Click a work instruction in the popup | Task opens in a **full new tab**, popup **closes**, Opportunity tab still untouched |
| 1e | Save the Task, close its tab | Back on the Opportunity, unchanged. Nothing to navigate back through |
| 1f | Click the button **twice** | The existing popup is **reused and focused**, not duplicated |
| 1g | **Block popups** in the browser, then click the button | Picker opens **in place** — the pre-1.1.0 behaviour. Feature still works. `WI_POPUP_BLOCKED` in the console |
| 1h | Open the picker URL **directly in a tab**, click a work instruction | Task opens in a new tab and the picker tab is **NOT closed**. This is the `window.opener` guard |
| 1i | Repeat 1a–1e from a **Customer** record | Same behaviour throughout |
| 2 | Open an Opportunity in **edit** and **create** mode | **No** button — view only |
| 3 | Open a **Customer** in view mode | Button present |
| 4 | Click the button from an Opportunity | Picker lists active types, sorted by name, one link each |
| 5 | Click a picker link | Task opens **on that type's custom form**, title = config name, work instruction field set |
| 6 | From an Opportunity, check the links | `company` = the Opportunity's customer, `transaction` = the Opportunity |
| 7 | From a Customer, check the links | `company` = the Customer, `transaction` **empty** |
| 8 | A type whose config has a **Default Assignee** | Assigned To = that employee. `WI_ASSIGNEE_RULE` logs rule 1. Live data: eight of ten records |
| 9 | A type with **no** Default Assignee, source record **has** a sales rep | Assigned To = the source record's own sales rep. Logs rule 2. Use *Requote Required* or *Sales Contact Requested* |
| 10 | A type with no Default Assignee, source record has **no** sales rep | Assigned To **empty**. Logs rule 3. Task still opens |
| 11 | A config record with offset **`0`** | Due date = **today**, not blank. This is the case a truthiness bug would break |
| 12 | A config record with a **positive** offset | Due date = today + n days |
| 13 | A config record with a **blank** offset | Due date **left empty** — not defaulted to today |
| 14 | A config record with **no form internal ID** | **Absent** from the picker. `WI_CONFIG_INCOMPLETE` names it |
| 15 | Deactivate every config record, open the picker | Plain "no active work instruction types are configured" message. **No empty list, no default form** |
| 16 | Create a Task **the ordinary way**, without the button | Task opens untouched. No prefill, no error. Work instruction field empty — Phase 3 handles this |
| 17 | Build a saved search on `custevent_work_instruction_type` | Tasks raised via the picker appear, grouped by type. **This is the reporting failure the project exists to fix** |
| 18 | A config record whose priority text is not High/Medium/Low | Priority **unset**, `WI_PRIORITY_UNMAPPED` logs both the text and the internal ID |
| 19 | Confirm the picker link target | **Verified 2026-08-20** — `url.resolveTaskLink({id: 'EDIT_TASK'})` resolves correctly and Tasks open on the right form |
| 20 | Raise a Task **through the picker** | Full prefill, unchanged from 1.0.0. `WI_PREFILL_PATH` reports path 1 |
| 21 | Create a Task with the **ordinary New Task button**, on a work instruction form | Type **populated**. Priority, due date, assignee, company and transaction **untouched**. `WI_PREFILL_PATH` reports path 2 |
| 22 | Create a Task on a form mapping to **no** config record | Nothing set, no error, **no error-level log**. `WI_FORM_UNMAPPED` at debug only |
| 23 | Create a Task that **already has a type** | Existing value **not overwritten** |
| 24 | Change the type on a saved Task by **inline edit** | Change **succeeds**. `WI_TYPE_CHANGED` in the execution log with old value, new value and user |
| 25 | Temporarily point **two config records at the same form internal ID**, then create a Task on that form | Type left **blank**. `WI_FORM_AMBIGUOUS` fires at error level naming **both** records. **Revert the config afterwards** |
| 26 | New Task on the default form, switch to *Redraw Required* | Type, priority, due date and assignee **all populate on screen** |
| 27 | Change the assignee by hand, then reload the **same** form | The hand-set assignee **survives** |
| 28 | Switch from *Redraw Required* to *Measure Plans* | All four values **update** to Measure Plans' configuration |
| 29 | Switch to a form with **no** config record | Nothing further set, previous values remain, **debug log only**. Note the stale type described in section 6 |
| 30 | Save the Task from scenario 26 | Values persist as shown |
| 31 | Raise a Task through the picker | `beforeSubmit` exits immediately — **no second recovery** in the log |
| 32 | CSV import a Task on a work instruction form, **"Run Server SuiteScript" ticked** | Type and empty fields populated. Priority is **not** set — see section 6 |
| 33 | The same import **unticked** | Nothing set. **This is expected**, not a fault |
| 34 | Set a config offset to a **negative** number and raise it | Due date **untouched**, `WI_OFFSET_INVALID` logged. **Revert the config afterwards** |
| 35 | Edit an old untyped Task and save | Nothing set, **no config search runs** |

---

## 10. Open items

### Confirmed NetSuite IDs

Script IDs only — **no internal IDs in this table.**

| Item | Script ID | Type | Confirmed by | Date |
|---|---|---|---|---|
| Work Instruction config custom record | `customrecord_wi_config` | Custom record | Steve | 2026-08-20 |
| Task field holding the work instruction | `custevent_work_instruction_type` | List/Record → config record | Steve | 2026-08-20 |
| Config field: custom form internal ID | `custrecord_wi_form_internal_id` | Integer | Steve | 2026-08-20 |
| Config field: default assignee | `custrecord_wi_default_assignee` | List/Record → Employee | Steve | 2026-08-20 |
| Config field: default priority | `custrecord_wi_default_priority` | List | Steve | 2026-08-20 |
| Config field: due date offset (days) | `custrecord_wi_due_date_offset` | Integer | Steve | 2026-08-20 |

UI display name of `customrecord_wi_config` is *Work Instruction Configuration*. One record, two
names.

**Withdrawn:** *Config field: assignment source.* No such field exists and none will be created.
The name that circulated during design was a placeholder and was never in the account, so there was
nothing to remove. The assignee rule in section 4 replaces it. Do not reintroduce it.

**Withdrawn:** *Task field holding the sourced offset.* No such field exists and none is needed —
the offset is read from the config record at runtime.

**Deprecated:** `custrecord_wi_default_form_type` — mis-built, being made inactive, must not be
read. See trap 6 in section 0.

### Closed questions

| # | Question | Resolution | Closed |
|---|---|---|---|
| 3 | Does a workflow remain as a server-side safety net? | **No.** Retired and being deleted. These scripts are the only writer. See section 5. | 2026-08-20 |
| 4 | Is the priority field a native or a hand-built list? | **Never established, and it does not matter.** Read as text, which is correct either way. See section 4. | 2026-08-20 |
| 5 | Which sales rep? | The **source record's own** `salesrep`. No cross-record fallback. | 2026-08-20 |
| 8 | Which roles see the button and may run the Suitelet? | **All Roles** for both. Suitelet stays Available Without Login: No. See section 8, and the permission limitation in section 6. | 2026-08-20 |
| — | Should recovery run on EDIT, backfilling history opportunistically? | **No.** It would search the config record on every Task edit in the account where the type is blank, and stamp values onto records opened for unrelated reasons. Backfill is a deliberate one-off job. See section 5. | 2026-08-20 |
| — | What should a negative due date offset do? | **Treated as unset**, and logged as `WI_OFFSET_INVALID`. See section 5. | 2026-08-20 |
| 6 | Is there a Task field holding the sourced offset? | **No**, and none needed. | 2026-08-20 |
| 7 | Which Task field links back to the source? | Native `company` and `transaction`. No custom field. See section 4. | 2026-08-20 |

### Unresolved questions

| # | Question | Status |
|---|---|---|
| 1 | Button on Opportunity only, or Customer as well? | **Open.** Built for both — one script record, two deployments. Dropping Customer means removing a deployment, not changing code. |
| 2 | Does the picker let the user override assignee and priority, or set them silently? | **Open.** Currently silent: the picker is a one-click list and the user edits the Task afterwards. |


### NetSuite configuration tasks for Steve

Not code. These are account changes that the scripts assume have been made.

| # | Task | Why it matters |
|---|---|---|
| 1 | Set `custevent_work_instruction_type` to **Inline Text** on all Task forms | Users must not be able to edit it. `beforeSubmit` logs changes rather than blocking them precisely because the field is expected to be read-only in the UI — if it is editable, `WI_TYPE_CHANGED` will fire on ordinary user edits and the signal is lost. |
| 2 | Mark `custrecord_wi_default_form_type` **Inactive** | The mis-built field. Trap 6 in section 0 warns against it, but inactive is better than documented. |
| 3 | Confirm the routing **workflow has been deleted** | Section 5 records it as retired. Confirm rather than assume — if it still runs, there are two writers of the type field and the ordering question comes back. |

### Still open

| Item | Status |
|---|---|
| Task title refinement | Currently the config record name alone. Provisional pending Steve seeing it in use. |
| Backfilling historical Tasks | **Still open, and deliberately not automated.** Recovery runs on create only — see the reasoning in section 5. If it is ever wanted, the method is: a saved search of Tasks on a work instruction form with no work instruction type, then a one-off Map/Reduce or a CSV update. A one-off job, run knowingly. |
