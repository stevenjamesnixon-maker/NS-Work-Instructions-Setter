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
 * beforeSubmit logs changes to the work instruction type. It does not block them.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.1.0
 */
define(['N/search', 'N/runtime', 'N/log', './lib/wi_lib_config'],
    function (search, runtime, log, wiConfig) {

    'use strict';

    var VERSION = '1.1.0';

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
     * Applies the assignee rule and logs which branch was taken, with the raw configured value.
     *
     *   1. Default Assignee populated on the config record -> use it.
     *   2. Otherwise -> the source record's own sales rep.
     *   3. Otherwise -> leave Assigned To empty.
     *
     * There is no cross-record fallback: an Opportunity uses the Opportunity's sales rep, a
     * Customer uses the Customer's. If neither is set, the user assigns the Task by hand.
     *
     * @param {Object} newRecord
     * @param {Object} config
     * @param {Object} source
     * @returns {void}
     */
    function applyAssignee(newRecord, config, source) {
        var chosen = null;
        var rule;

        if (config.defaultAssignee !== null) {
            chosen = config.defaultAssignee;
            rule = '1 (config default assignee)';
        } else if (source.salesRep !== null) {
            chosen = source.salesRep;
            rule = '2 (source record sales rep)';
        } else {
            rule = '3 (left empty)';
        }

        if (chosen !== null) {
            newRecord.setValue({
                fieldId: wiConfig.TASK_NATIVE_FIELDS.ASSIGNED,
                value: chosen
            });
        }

        log.audit({
            title: wiConfig.LOG_PREFIX + 'ASSIGNEE_RULE',
            details: 'Config "' + config.name + '" (id ' + config.id + '): applied rule ' + rule +
                '. Raw default assignee ' + JSON.stringify(config.defaultAssignee) +
                ', source sales rep ' + JSON.stringify(source.salesRep) +
                ', assigned ' + JSON.stringify(chosen) + '.'
        });
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

        if (existing) {
            log.audit({
                title: wiConfig.LOG_PREFIX + 'PREFILL_PATH',
                details: 'Path 2 skipped: the work instruction type is already set to ' +
                    JSON.stringify(existing) + '. Existing values are never overwritten.'
            });
            return;
        }

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

        newRecord.setValue({
            fieldId: wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE,
            value: config.id
        });

        log.audit({
            title: wiConfig.LOG_PREFIX + 'PREFILL_PATH',
            details: 'Path 2: recovered from form internal id ' + JSON.stringify(formId) +
                ' as "' + config.name + '" (id ' + config.id + '). Type set; nothing else touched.'
        });
    }

    /**
     * @param {Object} context
     * @param {Object} context.newRecord
     * @param {Object} context.request
     * @param {string} context.type
     * @returns {void}
     */
    function beforeLoad(context) {
        var parameters = null;

        try {
            // CREATE only. On view and edit the values are already on the record, and writing them
            // again would overwrite whatever the user has since chosen.
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

            if (config.priority !== null) {
                newRecord.setValue({
                    fieldId: wiConfig.TASK_NATIVE_FIELDS.PRIORITY,
                    value: config.priority
                });
            }

            // Three states, and null is NOT the same as 0. A null offset means leave the due date
            // alone; an offset of 0 means today. Testing truthiness here would silently skip the
            // due date on every config record that legitimately wants today.
            if (config.dueOffsetDays !== null) {
                newRecord.setValue({
                    fieldId: wiConfig.TASK_NATIVE_FIELDS.DUE_DATE,
                    value: dueDateFromOffset(config.dueOffsetDays)
                });
            }

            applyAssignee(newRecord, config, source);
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
     * Records changes to the work instruction type. VISIBILITY, NOT ENFORCEMENT.
     *
     * The field is Inline Text on the Task forms, so a user cannot edit it there. Any change
     * therefore arrives by inline edit from a list, by CSV update, or from another script — and
     * Steve needs to SEE those rather than have them prevented. Blocking the change would turn a
     * visible, investigable event into a support ticket about a Task that will not save.
     *
     * Only a change away from an existing value is logged. Filling in a blank is the safety net
     * doing its job, not an event worth reporting.
     *
     * @param {Object} context
     * @param {Object} context.newRecord
     * @param {Object} context.oldRecord
     * @param {string} context.type
     * @returns {void}
     */
    function beforeSubmit(context) {
        try {
            if (context.type !== context.UserEventType.EDIT &&
                context.type !== context.UserEventType.XEDIT) {
                return;
            }

            if (!context.oldRecord || !context.newRecord) {
                return;
            }

            var field = wiConfig.TASK_FIELDS.WORK_INSTRUCTION_TYPE;
            var oldValue = context.oldRecord.getValue({ fieldId: field });
            var newValue = context.newRecord.getValue({ fieldId: field });

            // Blank -> populated is the safety net working. Not an event.
            if (!oldValue) {
                return;
            }

            if (String(oldValue) === String(newValue)) {
                return;
            }

            var user = runtime.getCurrentUser();

            log.audit({
                title: wiConfig.LOG_PREFIX + 'TYPE_CHANGED',
                details: 'Task id ' + context.newRecord.id + ': work instruction type changed ' +
                    'from ' + JSON.stringify(oldValue) + ' to ' + JSON.stringify(newValue) +
                    ' by ' + (user ? user.name + ' (id ' + user.id + ')' : 'an unknown user') +
                    '. The change was NOT blocked.'
            });

        } catch (e) {
            // Logging must never stop a Task saving.
            log.error({
                title: wiConfig.LOG_PREFIX + 'TYPE_CHANGE_LOG_FAILED',
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
