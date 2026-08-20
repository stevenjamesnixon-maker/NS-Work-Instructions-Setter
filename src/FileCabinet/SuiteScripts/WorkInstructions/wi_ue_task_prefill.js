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
 * A Task created by any other route is left untouched in this phase. Deriving the work instruction
 * type by reverse lookup from the form is Phase 3.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/search', 'N/log', './lib/wi_lib_config'], function (search, log, wiConfig) {

    'use strict';

    var VERSION = '1.0.0';

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
                // A Task created any other way is untouched in this phase. Phase 3 adds the
                // reverse lookup from custom form to work instruction type.
                return;
            }

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

    return {
        VERSION: VERSION,
        beforeLoad: beforeLoad
    };

});
