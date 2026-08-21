/**
 * wi_ue_task_prefill.js
 *
 * Applies the work instruction's configured values to a new Task, in beforeLoad, before the page
 * renders. This is the ONLY writer of the work instruction field (TASK_FIELDS in
 * wi_lib_config.js) — the picker deliberately does not set it via the URL, so there is exactly
 * one writer.
 *
 * The custom form has already been chosen by the picker and arrives in the URL. Nothing here
 * touches the form: switching the form on a rendered record clears the very fields set below.
 * See docs/context.md section 0, trap 2.
 *
 * A Task created outside the picker still has the right custom form, because the user chose it.
 * The work instruction type is therefore recovered from the form — see deriveTypeFromForm below.
 * Only the type is recovered; nothing else on such a Task is touched.
 *
 * The work instruction on an already-saved Task is corrected by wi_cs_task_form.js, a CLIENT
 * SCRIPT attached below via clientScriptModulePath. It cannot be done here: NetSuite ignores
 * writes to a record that beforeLoad has loaded. See the banner before beforeLoad — that mistake
 * has already been made once and shipped to Sandbox.
 *
 * beforeSubmit keeps a narrower version of the same correction as a backstop for form changes
 * that never render a page. It and the client script are deliberately asymmetric; the banner
 * above rederiveTypeOnFormChange explains why, and it is not an oversight to tidy.
 *
 * beforeSubmit does three things, split by event type. On CREATE it is the save-time safety net
 * (path 3). On EDIT it re-derives the TYPE ONLY when the CUSTOM FORM has changed — see
 * rederiveTypeOnFormChange. On EDIT and XEDIT alike it logs a change to the work instruction type
 * that this script did not make. It never blocks a save.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.5.0
 */
define(['N/search', 'N/runtime', 'N/log', './lib/wi_lib_config'],
    function (search, runtime, log, wiConfig) {

    'use strict';

    var VERSION = '1.5.0';

    /**
     * Reads a value from a search.lookupFields result. Select fields come back as an array of
     * { value, text } rather than as a scalar.
     *
     * @param {Object} lookup
     * @param {string} fieldId
     * @returns {string|null}
     */
    function lookupValue(lookup, fieldId) {
        if (!lookup || !lookup.hasOwnProperty(fieldId)) {
            return null;
        }

        var raw = lookup[fieldId];

        if (Object.prototype.toString.call(raw) === '[object Array]') {
            return raw.length > 0 && raw[0] && raw[0].value ? String(raw[0].value) : null;
        }

        if (raw === null || raw === undefined || String(raw) === '') {
            return null;
        }

        return String(raw);
    }

    /**
     * Reads the fields this script needs from the source record.
     *
     * lookupFields is safe here: entity and salesrep are stored fields, not computed ones.
     *
     * @param {string} sourceType
     * @param {string} sourceId
     * @returns {Object} { salesRep, customer }
     */
    function readSource(sourceType, sourceId) {
        var empty = { salesRep: null, customer: null };

        if (!sourceType || !sourceId) {
            return empty;
        }

        var columns = [wiConfig.SOURCE_FIELDS.SALES_REP];

        // Only an Opportunity carries the customer on a separate field. On a Customer the source
        // record IS the customer.
        if (sourceType === wiConfig.SOURCE_TYPES.OPPORTUNITY) {
            columns.push(wiConfig.SOURCE_FIELDS.ENTITY);
        }

        var lookup = search.lookupFields({
            type: sourceType,
            id: sourceId,
            columns: columns
        });

        return {
            salesRep: lookupValue(lookup, wiConfig.SOURCE_FIELDS.SALES_REP),
            customer: sourceType === wiConfig.SOURCE_TYPES.OPPORTUNITY
                ? lookupValue(lookup, wiConfig.SOURCE_FIELDS.ENTITY)
                : sourceId
        };
    }

    /**
     * Today plus a whole number of days.
     *
     * @param {number} days
     * @returns {Date}
     */
    function dueDateFromOffset(days) {
        var due = new Date();
        due.setDate(due.getDate() + days);
        return due;
    }

    /**
     * True when a Task field currently holds nothing.
     *
     * NOTE: this can never be true for `priority`. NetSuite defaults a new Task to Medium, and
     * there is no way to tell that default apart from a user who chose Medium. The consequence is
     * recorded in docs/context.md section 6.
     *
     * @param {Object} newRecord
     * @param {string} fieldId
     * @returns {boolean}
     */
    function isFieldEmpty(newRecord, fieldId) {
        var current = newRecord.getValue({ fieldId: fieldId });
        return current === null || current === undefined || current === '';
    }

    /**
     * Are two NetSuite ids the same value? Compared as trimmed strings, because one side may
     * arrive as a number and the other as a string.
     *
     * @param {*} a
     * @param {*} b
     * @returns {boolean}
     */
    function sameId(a, b) {
        var left = (a === null || a === undefined) ? '' : String(a).replace(/^\s+|\s+$/g, '');
        var right = (b === null || b === undefined) ? '' : String(b).replace(/^\s+|\s+$/g, '');
        return left === right;
    }

    /**
     * Chooses the assignee. Rule order:
     *
     *   1. Default Assignee populated on the config record -> use it.
     *   2. Otherwise -> the source record's own sales rep.
     *   3. Otherwise -> leave Assigned To empty.
     *
     * There is no cross-record fallback: an Opportunity uses the Opportunity's sales rep, a
     * Customer uses the Customer's. A hand-created Task has no source record at all, so it can
     * only ever reach rule 1 or rule 3.
     *
     * @param {Object} config
     * @param {Object} source
     * @returns {Object} { value, rule }
     */
    function chooseAssignee(config, source) {
        if (config.defaultAssignee !== null) {
            return { value: config.defaultAssignee, rule: '1 (config default assignee)' };
        }

        if (source.salesRep !== null) {
            return { value: source.salesRep, rule: '2 (source record sales rep)' };
        }

        return { value: null, rule: '3 (left empty)' };
    }

    /**
     * THE ONE IMPLEMENTATION of "apply this configuration's values to this Task".
     *
     * Paths 1, 2 and 3 all route through here. Three copies of the assignee rule that have to
     * agree with each other would be a latent bug, so there is exactly one copy.
     *
     * `force` decides what happens to a field that already holds something:
     *
     *   force === true   overwrite it. Used when the derived work instruction type CHANGED on
     *                    this load: the old values were derived from the previous configuration
     *                    and are stale the moment the type moves. Leaving one queue's assignee on
     *                    another queue's work is exactly the mis-routing this exists to fix.
     *   force === false  fill only what is empty, so a plain reload never clobbers what the user
     *                    has typed.
     *
     * Company and transaction are NOT set here — they belong to path 1 only, which has a source
     * record to link to.
     *
     * The title is not set here either, because the two callers that set it do not agree on the
     * rule: path 1 writes it unconditionally, path 2 only when it is empty. A shared function
     * taking a flag for a two-caller difference would hide that distinction rather than express
     * it, so each path sets the title itself.
     *
     * @param {Object} newRecord
     * @param {Object} config
     * @param {Object} source - { salesRep, customer }; empty for a hand-created Task
     * @param {boolean} force
     * @param {string} pathLabel - for the audit line
     * @returns {void}
     */
    function applyConfigValues(newRecord, config, source, force, pathLabel) {
        var fields = wiConfig.TASK_NATIVE_FIELDS;

        if (config.priority !== null &&
            (force || isFieldEmpty(newRecord, fields.PRIORITY))) {
            newRecord.setValue({ fieldId: fields.PRIORITY, value: config.priority });
        }

        // Three states, and null is NOT the same as 0. A null offset means leave the due date
        // alone; an offset of 0 means today. Testing truthiness here would silently skip the due
        // date on every config record that legitimately wants today.
        if (config.dueOffsetDays !== null &&
            (force || isFieldEmpty(newRecord, fields.DUE_DATE))) {
            newRecord.setValue({
                fieldId: fields.DUE_DATE,
                value: dueDateFromOffset(config.dueOffsetDays)
            });
        }

        var assignee = chooseAssignee(config, source);

        if (assignee.value !== null && (force || isFieldEmpty(newRecord, fields.ASSIGNED))) {
            newRecord.setValue({ fieldId: fields.ASSIGNED, value: assignee.value });
        }

        log.audit({
            title: wiConfig.LOG_PREFIX + 'ASSIGNEE_RULE',
            details: pathLabel + ' — config "' + config.name + '" (id ' + config.id +
                '): applied rule ' + assignee.rule + ', force=' + force +
                '. Raw default assignee ' + JSON.stringify(config.defaultAssignee) +
                ', source sales rep ' + JSON.stringify(source.salesRep) +
                ', chosen ' + JSON.stringify(assignee.value) + '.'
        });
    }

    /**
     * A hand-created Task has no source record, so there is no sales rep and no customer to link.
     *
     * @returns {Object}
     */
    function emptySource() {
        return { salesRep: null, customer: null };
    }

    /**
     * Links the Task back to the record it was raised from, using native Task fields.
     *
     *   From an Opportunity -> company = the Opportunity's customer, transaction = the Opportunity
     *   From a Customer     -> company = the Customer, transaction = left empty
     *
     * @param {Object} newRecord
     * @param {string} sourceType
     * @param {string} sourceId
     * @param {Object} source
     * @returns {void}
     */
    function applySourceLinks(newRecord, sourceType, sourceId, source) {
        if (source.customer !== null) {
            newRecord.setValue({
                fieldId: wiConfig.TASK_NATIVE_FIELDS.COMPANY,
                value: source.customer
            });
        }

        if (sourceType === wiConfig.SOURCE_TYPES.OPPORTUNITY) {
            newRecord.setValue({
                fieldId: wiConfig.TASK_NATIVE_FIELDS.TRANSACTION,
                value: sourceId
            });
        }
    }

    /**
     * Path 2 and path 3 of the precedence in beforeLoad.
     *
     * A Task raised outside the picker carries no work instruction type and is therefore invisible
     * to every report this feature exists to produce. The custom form is still correct, because
     * whoever created the Task chose it, so the type is recovered from the form.
     *
     * ONLY the type is set. Priority, due date, assignee, company and transaction are deliberately
     * left alone: this is a Task somebody created by hand, and they have already set those values.
     * Overwriting them would be destructive, and recovering a missing type is the whole job here.
     *
     * The field is set only when it is currently empty. An existing value is never overwritten.
     *
     * @param {Object} newRecord
     * @returns {void}
     */
    function deriveTypeFromForm(newRecord) {
        var formId = newRecord.getValue({
            fieldId: wiConfig.TASK_NATIVE_FIELDS.CUSTOM_FORM
        });

        var existing = newRecord.getValue({
            fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE
        });

        var config = wiConfig.getByFormId(formId);

        if (config === null) {
            // Path 3. DEBUG, not error: most Tasks in the account have nothing to do with this
            // feature, and an error-level line on every one of them would bury real problems.
            // An ambiguous mapping has already logged WI_FORM_AMBIGUOUS at error level.
            log.debug({
                title: wiConfig.LOG_PREFIX + 'FORM_UNMAPPED',
                details: 'Form internal id ' + JSON.stringify(formId) + ' maps to no single ' +
                    'active configuration record. Nothing was set.'
            });
            return;
        }

        // The type is set UNCONDITIONALLY here, unlike everywhere else. On this path the FORM is
        // the identity: if a user switches from one work instruction form to another mid-create
        // the page reloads, and an only-when-empty rule would leave the type naming the form they
        // just abandoned. The form is authoritative; the type follows it.
        var typeChanged = !sameId(existing, config.id);

        newRecord.setValue({
            fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE,
            value: config.id
        });

        // TITLE IS THE ONE FIELD `force` DOES NOT GOVERN, and the exception is deliberate.
        //
        // Priority, due date and assignee are DERIVED values: they came from a configuration
        // record, so when the type moves they are stale and are re-applied in full below. A title
        // is not derived — it is a sentence a person composed. Overwriting it would throw away
        // something only they could have written, so it is set when it is EMPTY and at no other
        // time, even when force is true. A user who switches the form before typing a title gets
        // the config name, which beats blank; a user who has already typed one keeps it.
        if (isFieldEmpty(newRecord, wiConfig.TASK_NATIVE_FIELDS.TITLE)) {
            newRecord.setValue({
                fieldId: wiConfig.TASK_NATIVE_FIELDS.TITLE,
                value: config.name
            });
        }

        // When the type changed, priority, due date and assignee were derived from the PREVIOUS
        // configuration and are stale — so they are re-applied from the new one. That does
        // overwrite anything the user typed by hand before switching forms. Accepted deliberately:
        // switching forms mid-create is rare, the result is coherent, and every one of these
        // fields is trivially re-editable on the page in front of them.
        //
        // On a plain reload of the same form nothing changed, so only empty fields are filled and
        // the user's own edits survive.
        //
        // Company and transaction stay untouched: a hand-created Task has no source record to
        // link to. The user sets Company themselves if they want it.
        applyConfigValues(newRecord, config, emptySource(), typeChanged, 'Path 2 (form recovery)');

        log.audit({
            title: wiConfig.LOG_PREFIX + 'PREFILL_PATH',
            details: 'Path 2: recovered from form internal id ' + JSON.stringify(formId) +
                ' as "' + config.name + '" (id ' + config.id + '). Type changed on this load: ' +
                typeChanged + '. Company and transaction untouched.'
        });
    }

    /* -------------------------------------------------------------------------------------- */
    /* WHY THERE IS NO EDIT BRANCH IN beforeLoad — READ THIS BEFORE ADDING ONE                  */
    /*                                                                                          */
    /* 1.4.0 put the edit-time re-derivation here, in beforeLoad, on EDIT. It DOES NOT WORK,     */
    /* and it does not fail in any way you can see. NetSuite's documentation:                    */
    /*                                                                                          */
    /*   "You can't update a record that's loaded in a beforeLoad script — if you try, that      */
    /*    logic is ignored."                                                                     */
    /*                                                                                          */
    /*   https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4407991781.html   */
    /*                                                                                          */
    /* That is why paths 1 and 2 work and an EDIT branch cannot. On CREATE the record is still   */
    /* being BUILT, so setValue takes effect and the page renders what was written. On EDIT the  */
    /* record has been LOADED from the database, and every write to newRecord is discarded —     */
    /* silently. No error, no log line, nothing in the execution log. The code runs, decides      */
    /* correctly, writes the value, logs that it wrote the value, and NetSuite throws it away.   */
    /* It cost a full Sandbox round to find, because everything except the screen said it worked. */
    /*                                                                                          */
    /* The supported mechanism, named in the same documentation, is a CLIENT SCRIPT pageInit.    */
    /* That is wi_cs_task_form.js, attached below via clientScriptModulePath. Any change to what */
    /* an edit-time re-derivation does belongs THERE, not here.                                  */
    /*                                                                                          */
    /* beforeSubmit keeps its own re-derivation. That one works, because beforeSubmit writes to  */
    /* a record on its way to the database rather than one on its way to a page. It stays the    */
    /* backstop for form changes that never render a page at all — a script, a CSV update, an    */
    /* integration. See the banner above rederiveTypeOnFormChange.                               */
    /* -------------------------------------------------------------------------------------- */


    /**
     * Attaches wi_cs_task_form.js to the Task edit page.
     *
     * A module PATH, not a file internal id. Paths are stable across environments;
     * clientScriptFileId would not be. Relative to this script's folder, so both files must sit
     * in the same File Cabinet folder — see docs/context.md section 8.
     *
     * The client script has no script record and no deployment. A File Cabinet upload is the
     * whole of its installation, exactly as for wi_cs_source_button.js.
     *
     * WRAPPED SEPARATELY so that a failure to attach cannot stop the Task page rendering. A Task
     * that opens without the re-derivation is the pre-1.5.0 behaviour and is survivable; a Task
     * form that will not open is not.
     *
     * @param {Object} form - context.form
     * @returns {void}
     */
    function attachTaskFormClientScript(form) {
        try {
            if (!form) {
                return;
            }

            form.clientScriptModulePath = './wi_cs_task_form.js';

        } catch (e) {
            log.error({
                title: wiConfig.LOG_PREFIX + 'CLIENT_SCRIPT_ATTACH_FAILED',
                details: 'Could not attach wi_cs_task_form.js to the Task edit form. The page ' +
                    'still opened, but switching the custom form will NOT re-derive the work ' +
                    'instruction — the save-time backstop in beforeSubmit is all that remains. ' +
                    'Check the file is in the same File Cabinet folder as this script. ' +
                    (e.name || '') + ': ' + (e.message || e)
            });
        }
    }

    /**
     * @param {Object} context
     * @param {Object} context.newRecord
     * @param {Object} context.form
     * @param {Object} context.request
     * @param {string} context.type
     * @returns {void}
     */
    function beforeLoad(context) {
        var parameters = null;

        try {
            // On EDIT the only thing this script can usefully do is ATTACH the client script
            // that does the work. It must not write to newRecord here — see the banner above.
            if (context.type === context.UserEventType.EDIT) {
                attachTaskFormClientScript(context.form);
                return;
            }

            // Everything below is CREATE only. On view the values are already on the record, and
            // writing them again would overwrite whatever the user has since chosen.
            if (context.type !== context.UserEventType.CREATE) {
                return;
            }

            // No request object means no URL, which means this was not raised from the picker.
            if (!context.request) {
                return;
            }

            parameters = context.request.parameters || {};

            var configId = parameters[wiConfig.URL_PARAMS.CONFIG_ID];
            if (!configId) {
                // Path 2 or 3: no picker parameter, so try to recover the type from the form.
                deriveTypeFromForm(context.newRecord);
                return;
            }

            log.audit({
                title: wiConfig.LOG_PREFIX + 'PREFILL_PATH',
                details: 'Path 1: raised through the picker with config id ' + configId + '. ' +
                    'Full prefill applied.'
            });

            var sourceType = parameters[wiConfig.URL_PARAMS.SOURCE_TYPE] || '';
            var sourceId = parameters[wiConfig.URL_PARAMS.SOURCE_ID] || '';

            // Throws WI_CONFIG_MISSING if the id does not resolve. Caught below.
            var config = wiConfig.getByTypeId(configId);
            var source = readSource(sourceType, sourceId);
            var newRecord = context.newRecord;

            newRecord.setValue({
                fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE,
                value: config.id
            });

            newRecord.setValue({
                fieldId: wiConfig.TASK_NATIVE_FIELDS.TITLE,
                value: config.name
            });

            // Path 1 forces: everything on the Task came from the picker a moment ago, so there
            // is nothing of the user's to preserve.
            applyConfigValues(newRecord, config, source, true, 'Path 1 (picker)');
            applySourceLinks(newRecord, sourceType, sourceId, source);

        } catch (e) {
            // Let the page render regardless. A half-populated Task the user can correct beats a
            // Task form that will not open.
            log.error({
                title: wiConfig.LOG_PREFIX + 'PREFILL_FAILED',
                details: 'Could not prefill the Task. Parameters received: ' +
                    JSON.stringify(parameters) + '. ' + (e.name || '') + ': ' + (e.message || e)
            });
        }
    }


    /**
     * Path 3 — save-time recovery. CREATE only.
     *
     * beforeLoad never fires for a CSV import or for most integrations, so a Task arriving by
     * those routes reaches beforeSubmit with no work instruction type. This is the only place
     * that catches them.
     *
     * NOTE the condition NetSuite imposes: a CSV import fires user events ONLY when "Run Server
     * SuiteScript and Trigger Workflows" is ticked on the import. Untick it and nothing here runs.
     * See docs/context.md section 6.
     *
     * WHY CREATE ONLY, and not EDIT:
     *
     *   - On EDIT this would search the configuration record on every Task edit in the account
     *     where the type happens to be blank — every unrelated Task anybody touches. The benefit
     *     is opportunistic backfill of history; the cost is a search on work that has nothing to
     *     do with this feature.
     *   - It would also stamp values onto an old Task somebody opened for an entirely unrelated
     *     reason, silently. Backfilling history is a deliberate one-off job, not a side effect of
     *     someone fixing a typo.
     *
     * XEDIT is excluded regardless: newRecord is sparse on inline edit and customform may not be
     * present at all.
     *
     * In the common case this exits on ONE getValue — a Task raised through the picker already
     * had its type set in beforeLoad, so the check finds it populated and returns without a
     * search.
     *
     * @param {Object} newRecord
     * @returns {void}
     */
    function recoverTypeOnSave(newRecord) {
        var existing = newRecord.getValue({
            fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE
        });

        if (existing) {
            // Already typed — by the picker, by beforeLoad, or by the importer. Nothing to do,
            // and deliberately nothing logged: this is the common case on every saved Task.
            return;
        }

        var formId = newRecord.getValue({
            fieldId: wiConfig.TASK_NATIVE_FIELDS.CUSTOM_FORM
        });

        var config = wiConfig.getByFormId(formId);

        if (config === null) {
            log.debug({
                title: wiConfig.LOG_PREFIX + 'FORM_UNMAPPED',
                details: 'Path 3: form internal id ' + JSON.stringify(formId) + ' maps to no ' +
                    'single active configuration record. Nothing was set.'
            });
            return;
        }

        newRecord.setValue({
            fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE,
            value: config.id
        });

        // Only what is empty. Whoever created this Task may have set values deliberately, and
        // there is no previous configuration here whose values could have gone stale.
        applyConfigValues(newRecord, config, emptySource(), false, 'Path 3 (save-time recovery)');

        log.audit({
            title: wiConfig.LOG_PREFIX + 'PREFILL_PATH',
            details: 'Path 3: recovered at save from form internal id ' + JSON.stringify(formId) +
                ' as "' + config.name + '" (id ' + config.id + '). Empty fields filled only.'
        });
    }

    /**
     * Re-derives the work instruction type when the CUSTOM FORM changes on an already-saved Task.
     *
     * THE GAP THIS CLOSES: paths 1 to 3 are all CREATE-only, so before this existed a user who
     * opened a saved Task and switched the form was left with a Task sitting on the Measure Plans
     * form while its type still said Redraw Required. The type field is Inline Text, so they could
     * not correct it by hand either — the only route out was to delete the Task and raise it
     * again. Realising you picked the wrong work instruction and switching the form is ordinary
     * behaviour, not a mistake, so it needs closing.
     *
     * EDIT ONLY. Not CREATE — paths 1 to 3 already cover that. Not XEDIT: newRecord is sparse on
     * inline edit and customform may not be present at all, so the comparison below could not be
     * trusted to mean what it says.
     *
     * THE FORM COMPARISON COMES FIRST, and that ordering is the whole cost argument. Almost every
     * edit in the account leaves the form alone, and those edits return here on two getValue calls
     * — no search, no governance, nothing. Only the rare edit that actually switches form reaches
     * the lookup. Do not move the search above this guard, and do not "simplify" the guard away:
     * without it this becomes a config search on every Task edit in the account, which is exactly
     * what save-time recovery was kept off EDIT to avoid (docs/context.md section 5).
     *
     * ONLY THE TYPE IS RE-DERIVED HERE. Not assignee, not due date, not priority — and that is
     * the deliberate asymmetry with rederiveTypeOnEditLoad described in the banner above. A form
     * change that reaches THIS function never rendered a page: it came from a script, a CSV
     * update or an integration, so there was no review step and nobody saw it. Reassigning
     * somebody's work from a path with no review is a different and worse thing than doing it on
     * a page the user is looking at. Conservative where nobody is watching. DO NOT add
     * applyConfigValues here to make the two sites match.
     *
     * In the ordinary UI flow this function finds nothing to do, because beforeLoad already
     * corrected the type when the page reloaded on the new form. It exists for the flows that
     * have no beforeLoad at all.
     *
     * @param {Object} oldRecord
     * @param {Object} newRecord
     * @param {*} currentType - the type as it ARRIVED, read before anything here could write it
     * @returns {Object|null} the configuration the CURRENT form maps to, when it was looked up
     *                        here; null when no lookup happened (the form did not change) or the
     *                        form maps to nothing. Handed to formExplainsType so that the same
     *                        lookup is never paid for twice in one save.
     */
    function rederiveTypeOnFormChange(oldRecord, newRecord, currentType) {
        var formField = wiConfig.TASK_NATIVE_FIELDS.CUSTOM_FORM;

        var oldForm = oldRecord.getValue({ fieldId: formField });
        var newForm = newRecord.getValue({ fieldId: formField });

        // The guard described above. Almost every edit stops here, having looked nothing up —
        // which is why the return value is null: there is no configuration to hand on.
        if (sameId(oldForm, newForm)) {
            return null;
        }

        var config = wiConfig.getByFormId(newForm);

        if (config === null) {
            // The new form maps to nothing, or maps ambiguously. LEAVE THE EXISTING TYPE ALONE.
            // Consistent with path 4, and clearing it would destroy real data on the strength of
            // a configuration gap — the stale-type limitation in docs/context.md section 6 is the
            // lesser harm. An ambiguous mapping has already logged WI_FORM_AMBIGUOUS at error
            // level; debug here for the same volume reason as everywhere else.
            log.debug({
                title: wiConfig.LOG_PREFIX + 'FORM_UNMAPPED',
                details: 'Task id ' + newRecord.id + ': the form changed from ' +
                    JSON.stringify(oldForm) + ' to ' + JSON.stringify(newForm) + ', which maps ' +
                    'to no single active configuration record. The existing work instruction ' +
                    'type was left in place.'
            });
            return null;
        }

        // Already agrees with the new form — in the ordinary UI flow because beforeLoad set it
        // when the page reloaded, and the user has seen it. Nothing to write and nothing to log
        // a second time. The config is still returned: formExplainsType needs it.
        if (sameId(currentType, config.id)) {
            return config;
        }

        newRecord.setValue({
            fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE,
            value: config.id
        });

        // Its OWN key, not WI_TYPE_CHANGED. WI_TYPE_CHANGED exists to surface a person editing a
        // field they are not supposed to be able to edit; if this script's own correction appeared
        // under that key it would read as exactly that and destroy the signal. A person changing
        // the type and the system correcting it after a form switch must be tellable apart at a
        // glance. See beforeSubmit for how the two are kept disjoint.
        log.audit({
            title: wiConfig.LOG_PREFIX + 'TYPE_REDERIVED',
            details: 'Task id ' + newRecord.id + ': the custom form changed from ' +
                JSON.stringify(oldForm) + ' to ' + JSON.stringify(newForm) + ', so the work ' +
                'instruction type was re-derived from ' + JSON.stringify(currentType) + ' to "' +
                config.name + '" (id ' + config.id + '). Assignee, due date and priority were ' +
                'deliberately left alone — this change arrived without a page, so nobody ' +
                'reviewed it. See the asymmetry banner in this file.'
        });

        return config;
    }

    /**
     * Does the work instruction type on this record agree with the form the record is on?
     *
     * THIS IS THE ONE QUESTION THAT SEPARATES THE TWO LOG KEYS, and getting it wrong destroys the
     * signal `WI_TYPE_CHANGED` exists to give. Both re-derivation sites leave the same fingerprint
     * behind — a type that changed during this save and now MATCHES the form. A person editing the
     * field by hand leaves a different one: a type that changed to something the form does not
     * account for. So the rule is not "did the type change" but:
     *
     *   WI_TYPE_CHANGED fires when the type changed to something THE FORM DOES NOT EXPLAIN.
     *
     * That is also the sharper signal in its own right. A Task whose type and form disagree is the
     * data-quality event worth investigating; a type that agrees with its form is, by this
     * feature's own definition, the right value however it got there.
     *
     * On XEDIT this returns false without searching: `customform` is not present on a sparse
     * inline-edit record, so `getByFormId` is handed nothing and returns null. That is the correct
     * answer there — an inline edit of the type field has no form change to justify it, and
     * WI_TYPE_CHANGED should fire.
     *
     * @param {Object} newRecord
     * @param {*} typeValue - the type to test, as it arrived
     * @param {Object|null} knownConfig - the config for the current form if it has ALREADY been
     *                                    looked up in this save; null to look it up here
     * @returns {boolean}
     */
    function formExplainsType(newRecord, typeValue, knownConfig) {
        var config = knownConfig;

        if (config === null) {
            config = wiConfig.getByFormId(newRecord.getValue({
                fieldId: wiConfig.TASK_NATIVE_FIELDS.CUSTOM_FORM
            }));
        }

        if (config === null) {
            return false;
        }

        return sameId(typeValue, config.id);
    }

    /**
     * Three jobs, split by event type:
     *
     *   CREATE        -> path 3, save-time recovery. See recoverTypeOnSave.
     *   EDIT          -> re-derive the type if the custom form changed. See
     *                    rederiveTypeOnFormChange.
     *   EDIT / XEDIT  -> record changes to the work instruction type this script did not make.
     *
     * The last is VISIBILITY, NOT ENFORCEMENT.
     *
     * The field is Inline Text on the Task forms, so a user cannot edit it there. Any change
     * therefore arrives by inline edit from a list, by CSV update, or from another script — and
     * Steve needs to SEE those rather than have them prevented. Blocking the change would turn a
     * visible, investigable event into a support ticket about a Task that will not save.
     *
     * Only a change away from an existing value is logged. Filling in a blank is the safety net
     * doing its job, not an event worth reporting.
     *
     * THE TWO LOGGERS ARE KEPT DISJOINT BY TWO MECHANISMS, and both are needed:
     *
     *   1. The incoming type is read ONCE, before anything here can write to it. Everything
     *      WI_TYPE_CHANGED reports is decided from that captured value, so a re-derivation
     *      performed BELOW cannot be reported as a user edit, and the logged "to" value is
     *      honest. Do not re-read the field after the re-derivation call.
     *
     *   2. The captured value is then tested with formExplainsType. This catches the case the
     *      capture cannot: a re-derivation that happened in beforeLoad, on the edit page load,
     *      arrives here as an already-changed value and is indistinguishable from an inline edit
     *      by the capture alone. Asking whether the FORM EXPLAINS the new type separates them —
     *      see formExplainsType, which is where the rule is stated.
     *
     * Mechanism 2 was added in 1.4.0 with the move of re-derivation to beforeLoad. Without it,
     * every visible reclassification would also log WI_TYPE_CHANGED against the user who made it,
     * which is exactly the false signal the separate WI_TYPE_REDERIVED key exists to prevent.
     *
     * @param {Object} context
     * @param {Object} context.newRecord
     * @param {Object} context.oldRecord
     * @param {string} context.type
     * @returns {void}
     */
    function beforeSubmit(context) {
        try {
            // Path 3 runs here and nowhere else, then stops: there is no old value to compare
            // against on a create, so the type-change logging below cannot apply.
            if (context.type === context.UserEventType.CREATE) {
                recoverTypeOnSave(context.newRecord);
                return;
            }

            if (context.type !== context.UserEventType.EDIT &&
                context.type !== context.UserEventType.XEDIT) {
                return;
            }

            if (!context.oldRecord || !context.newRecord) {
                return;
            }

            var field = wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE;
            var oldValue = context.oldRecord.getValue({ fieldId: field });

            // READ ONCE, HERE, BEFORE ANYTHING BELOW CAN WRITE TO THE FIELD. Everything the
            // WI_TYPE_CHANGED logger decides is decided from this value, which is why a
            // re-derivation can never be mistaken for a user editing the type. Do not re-read
            // the field after the call below — that would reintroduce exactly the confusion the
            // separate WI_TYPE_REDERIVED key exists to prevent.
            var incomingValue = context.newRecord.getValue({ fieldId: field });

            // EDIT only — see rederiveTypeOnFormChange for why XEDIT is excluded. Returns the
            // configuration for the current form when it looked one up, so the check below does
            // not pay for the same search twice.
            var formConfig = null;

            if (context.type === context.UserEventType.EDIT) {
                formConfig = rederiveTypeOnFormChange(
                    context.oldRecord, context.newRecord, incomingValue
                );
            }

            // Blank -> populated is the safety net working. Not an event.
            if (!oldValue) {
                return;
            }

            if (String(oldValue) === String(incomingValue)) {
                return;
            }

            // The type changed. Before reporting that as somebody editing a read-only field, ask
            // the only question that tells the two apart. A type that agrees with its form is a
            // re-derivation — this script's own work, already logged as WI_TYPE_REDERIVED at the
            // site that did it. Reaching here costs one small search, and only on the rare save
            // where the type actually moved.
            if (formExplainsType(context.newRecord, incomingValue, formConfig)) {
                return;
            }

            var user = runtime.getCurrentUser();

            log.audit({
                title: wiConfig.LOG_PREFIX + 'TYPE_CHANGED',
                details: 'Task id ' + context.newRecord.id + ': work instruction type changed ' +
                    'from ' + JSON.stringify(oldValue) + ' to ' + JSON.stringify(incomingValue) +
                    ' by ' + (user ? user.name + ' (id ' + user.id + ')' : 'an unknown user') +
                    '. The new value does NOT match the configuration for this Task\'s form, so ' +
                    'this was not a re-derivation. The change was NOT blocked.'
            });

        } catch (e) {
            // Neither recovery nor logging may stop a Task saving.
            log.error({
                title: wiConfig.LOG_PREFIX + 'BEFORE_SUBMIT_FAILED',
                details: (e.name || '') + ': ' + (e.message || e)
            });
        }
    }

    return {
        VERSION: VERSION,
        beforeLoad: beforeLoad,
        beforeSubmit: beforeSubmit
    };

});
