/**
 * wi_cs_task_form.js
 *
 * Re-derives the work instruction on a SAVED Task when its type disagrees with its custom form,
 * in pageInit, so the user SEES the corrected values on screen and can adjust them before saving.
 *
 * WHY THIS IS A CLIENT SCRIPT AND NOT A USER EVENT
 *
 * This was tried twice in wi_ue_task_prefill.js beforeLoad first, and it cannot work there.
 * NetSuite's documentation:
 *
 *   "You can't update a record that's loaded in a beforeLoad script — if you try, that logic is
 *    ignored."
 *
 *   https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4407991781.html
 *
 * On CREATE the record is still being built, which is why prefill paths 1 and 2 work. On EDIT it
 * has been loaded from the database and every write is discarded — silently, with no error and
 * nothing in the execution log. pageInit is the supported mechanism, named in that same page.
 *
 * WHAT IT DOES, on edit mode only:
 *
 *   form maps to nothing, or ambiguously  -> nothing. Most Tasks in the account.
 *   type already agrees with the form     -> nothing, and nothing logged.
 *   type DISAGREES, and was POPULATED     -> reclassification: type, assignee, priority and due
 *                                            date, all from the new configuration.
 *   type DISAGREES, and was EMPTY         -> the type ONLY. That Task predates the feature and
 *                                            its assignee was set by a person.
 *
 * The title is never re-derived. It is authored, not derived.
 *
 * LOGGING GOES TO THE BROWSER CONSOLE AND NOWHERE ELSE. This script is attached via
 * clientScriptModulePath and therefore has no script record to log against. Every WI_ key raised
 * here is invisible in the Script Execution Log no matter how long you search for it. Keep the
 * console open when testing. See docs/context.md section 7.
 *
 * This script is attached by wi_ue_task_prefill.js. It needs no script record and no deployment
 * record — only a File Cabinet upload into this same folder.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/log', './lib/wi_lib_config'], function (log, wiConfig) {

    'use strict';

    var VERSION = '1.0.0';

    /**
     * pageInit's mode for an existing record being edited. A platform literal, not a field ID, so
     * it does not belong in wi_lib_config.js with the script IDs. NetSuite passes 'create',
     * 'copy' or 'edit'; only 'edit' concerns this script.
     *
     * 'copy' is deliberately excluded. A copied Task is a NEW record, and the create-side prefill
     * paths in wi_ue_task_prefill.js already own that case.
     * @type {string}
     */
    var EDIT_MODE = 'edit';

    /**
     * Are two NetSuite ids the same value? Trimmed strings, because one side may arrive as a
     * number and the other as a string.
     *
     * DUPLICATED from wi_ue_task_prefill.js deliberately. It is four lines with no branching, and
     * the alternative — exporting it from wi_lib_config.js — would put a general-purpose string
     * helper into the module whose entire job is to hold NetSuite script IDs. If this ever grows
     * a third copy, move it to the library rather than writing one more.
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
     * Writes one field on the current record.
     *
     * ignoreFieldChange: true on every write. These values are being applied as a single
     * correction, not typed by the user, and firing fieldChanged for each of them would run
     * sourcing and any other client logic on the form four times over for one logical change.
     *
     * @param {Object} record - context.currentRecord
     * @param {string} fieldId
     * @param {*} value
     * @returns {void}
     */
    function setField(record, fieldId, value) {
        record.setValue({
            fieldId: fieldId,
            value: value,
            ignoreFieldChange: true
        });
    }

    /**
     * Applies the new configuration's derived values to a Task being reclassified.
     *
     * THIS IS A SECOND IMPLEMENTATION of applyConfigValues() in wi_ue_task_prefill.js, and the
     * duplication is deliberate but NOT free. Read this before changing either one.
     *
     * What is NOT duplicated is the part that would actually hurt: the priority text mapping and
     * the due date offset parsing — including the `0 means today` trap and the rejection of a
     * negative offset — both live in wi_lib_config.js and are reached through the SAME
     * getByFormId() call the server uses. By the time a config object exists, every value on it
     * has already been normalised in one place. This function only decides which of them to write.
     *
     * What IS duplicated is the write rule, and it is smaller here than on the server because two
     * of the server's branches cannot arise:
     *
     *   - The assignee rule has three branches server-side. Here only rule 1 (the config's default
     *     assignee) and rule 3 (leave it alone) can apply: a saved Task being edited has no source
     *     record to take a sales rep from, which is why the server passes emptySource() on this
     *     path too. There is no rule 2 to get wrong.
     *   - There is no `force` flag. A reclassification always overwrites, and the caller has
     *     already established that this is a reclassification.
     *
     * If the assignee rule ever gains a branch that applies to a saved Task, it must change in
     * both files — and at that point it should move into wi_lib_config.js instead. Recorded in
     * docs/context.md section 6.
     *
     * Company, transaction and TITLE are never touched. The title is authored, not derived.
     *
     * @param {Object} record - context.currentRecord
     * @param {Object} config - a config object from wiConfig.getByFormId()
     * @returns {Object} { assignee, priority, dueDate } as applied, for the log line
     */
    function applyDerivedValues(record, config) {
        var fields = wiConfig.TASK_NATIVE_FIELDS;
        var applied = { assignee: null, priority: null, dueDate: null };

        if (config.defaultAssignee !== null) {
            setField(record, fields.ASSIGNED, config.defaultAssignee);
            applied.assignee = config.defaultAssignee;
        }

        if (config.priority !== null) {
            setField(record, fields.PRIORITY, config.priority);
            applied.priority = config.priority;
        }

        // Three states, and null is NOT the same as 0. A null offset means leave the due date
        // alone; an offset of 0 means today. Testing truthiness here would silently skip the due
        // date on every config record that legitimately wants today.
        if (config.dueOffsetDays !== null) {
            applied.dueDate = dueDateFromOffset(config.dueOffsetDays);
            setField(record, fields.DUE_DATE, applied.dueDate);
        }

        return applied;
    }

    /**
     * Writes the work instruction type and CONFIRMS THE WRITE LANDED.
     *
     * The field is Inline Text on the Task forms, which is what stops users editing it. A display
     * type of Inline Text renders the value as static text rather than as a form control, and a
     * client script may not be able to write to it. If it cannot, the failure is silent: setValue
     * returns normally and nothing happens.
     *
     * So the value is read back. If it did not stick, WI_TYPE_NOT_WRITABLE names the fix — which
     * is a NetSuite configuration change, not a code change:
     *
     *   change the display type of the work instruction type field — TASK_FIELDS in
     *   wi_lib_config.js — from Inline Text to DISABLED
     *
     * Disabled is still not user-editable, which is the property that matters (see the read-only
     * decision in docs/context.md section 5), but it is a real form control that a script can
     * write to.
     *
     * WHAT THE READ-BACK PROVES, AND WHAT IT DOES NOT. It proves the client record model accepted
     * the value. It does NOT prove NetSuite re-rendered the inline text on screen, or that the
     * value will be submitted with the form. Only a Sandbox test can confirm those: switch the
     * form, look at the field, then save and re-open. If the console is clean but the screen still
     * shows the old type, the answer is the same — make the field Disabled.
     *
     * @param {Object} record - context.currentRecord
     * @param {Object} config
     * @returns {boolean} true when the type is now set
     */
    function setTypeAndVerify(record, config) {
        var field = wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE;

        setField(record, field, config.id);

        if (sameId(record.getValue({ fieldId: field }), config.id)) {
            return true;
        }

        log.error({
            title: wiConfig.LOG_PREFIX + 'TYPE_NOT_WRITABLE',
            details: 'CONSOLE ONLY. Could not set ' + field + ' to ' + JSON.stringify(config.id) +
                ' ("' + config.name + '") — the value did not stick, which means a client script ' +
                'cannot write this field at its current display type. NOTHING ELSE WAS CHANGED, ' +
                'deliberately: a Task carrying a new assignee and due date under its OLD work ' +
                'instruction type would be worse than one left alone. THE FIX IS A NETSUITE ' +
                'CONFIGURATION CHANGE, NOT A CODE CHANGE: set the display type of ' + field +
                ' to Disabled instead of Inline Text. Disabled is still not user-editable but is ' +
                'a real form control a script can write to. See docs/context.md section 6.'
        });

        return false;
    }

    /**
     * Re-derives the work instruction when the type disagrees with the form.
     *
     * Two exits come first and between them absorb every ordinary edit in the account. Neither
     * writes anything:
     *
     *   the form maps to nothing or ambiguously -> return, debug line. Most Tasks.
     *   the type already agrees with the form   -> return, and NOTHING logged. "This Task is
     *                                              still what it always was" is not an event.
     *
     * @param {Object} record - context.currentRecord
     * @returns {void}
     */
    function rederiveFromForm(record) {
        var fields = wiConfig.TASK_NATIVE_FIELDS;

        var formId = record.getValue({ fieldId: fields.CUSTOM_FORM });
        var existingType = record.getValue({
            fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE
        });

        // Runs a saved search from the browser. See the governance and permissions notes in
        // docs/context.md section 6 — this is the one place in the feature that searches
        // client-side, so it runs as the CURRENT USER rather than in a server execution context.
        var config = wiConfig.getByFormId(formId);

        if (config === null) {
            // Unmapped or ambiguous. Nothing is written — in particular the existing type is NOT
            // cleared, for the same reason as everywhere else in this feature: clearing a real
            // value on the strength of a configuration gap destroys data. Debug, not error: most
            // Tasks in the account have nothing to do with this feature.
            log.debug({
                title: wiConfig.LOG_PREFIX + 'FORM_UNMAPPED',
                details: 'CONSOLE ONLY. Form internal id ' + JSON.stringify(formId) + ' maps to ' +
                    'no single active configuration record. Nothing was changed.'
            });
            return;
        }

        if (sameId(existingType, config.id)) {
            return;
        }

        // Empty is NOT the same as different, and collapsing the two would be destructive.
        var isReclassification = !!existingType;
        var previousAssignee = record.getValue({ fieldId: fields.ASSIGNED });

        if (!setTypeAndVerify(record, config)) {
            return;
        }

        var applied = null;

        if (isReclassification) {
            // The assignee, priority and due date on this Task were derived from the PREVIOUS
            // configuration and are stale the moment the type moves. The assignee follows the
            // work instruction because a Task whose work instruction changed but whose assignee
            // did not is sitting on the WRONG TEAM'S LIST, which is the failure this feature
            // exists to prevent.
            //
            // CONSEQUENCE, ACCEPTED DELIBERATELY: this moves a Task away from somebody who may
            // already have claimed it, and only the user making the change is told. It is
            // traceable in the line below, which records the assignee before and after.
            //
            // Nothing is saved until the user saves the record. Every value written here is on
            // the screen in front of them first, and they can change any of it or hit Cancel.
            // That visibility is the entire reason this runs in a client script — see the file
            // header.
            applied = applyDerivedValues(record, config);
        }

        log.audit({
            title: wiConfig.LOG_PREFIX + 'TYPE_REDERIVED',
            details: 'CONSOLE ONLY. Task on form ' + JSON.stringify(formId) + ': work ' +
                'instruction type re-derived from ' + JSON.stringify(existingType) + ' to ' +
                JSON.stringify(config.id) + ' ("' + config.name + '"). ' +
                (isReclassification
                    ? 'Reclassification: assignee ' + JSON.stringify(previousAssignee) + ' -> ' +
                      JSON.stringify(record.getValue({ fieldId: fields.ASSIGNED })) +
                      ', priority ' + JSON.stringify(applied.priority) + ', due date ' +
                      JSON.stringify(applied.dueDate) + '.'
                    : 'The type was empty, so ONLY the type was set — assignee, priority and due ' +
                      'date were left exactly as they were.') +
                ' The title was not touched. Nothing is saved until the user saves.'
        });
    }

    /**
     * @param {Object} context
     * @param {Object} context.currentRecord
     * @param {string} context.mode - 'create' | 'copy' | 'edit'
     * @returns {void}
     */
    function pageInit(context) {
        try {
            if (!context || context.mode !== EDIT_MODE) {
                return;
            }

            if (!context.currentRecord) {
                return;
            }

            rederiveFromForm(context.currentRecord);

        } catch (e) {
            // A Task the user can edit by hand beats a Task page that throws on load. The
            // save-time backstop in wi_ue_task_prefill.js beforeSubmit still applies.
            log.error({
                title: wiConfig.LOG_PREFIX + 'TASK_FORM_INIT_FAILED',
                details: 'CONSOLE ONLY. pageInit could not re-derive the work instruction. The ' +
                    'Task page is unaffected and can be edited normally. ' + (e.name || '') +
                    ': ' + (e.message || e)
            });
        }
    }

    return {
        VERSION: VERSION,
        pageInit: pageInit
    };

});
