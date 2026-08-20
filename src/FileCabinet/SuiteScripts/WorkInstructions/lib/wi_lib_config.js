/**
 * wi_lib_config.js
 *
 * Shared configuration module for the Work Instructions feature. This is the only module in the
 * project that knows the script IDs of the Work Instruction configuration record and its fields,
 * and the only module that reads customrecord_wi_config. Every other script imports from here
 * rather than restating an ID or running its own search.
 *
 * Shared AMD module: no script record and no deployment record is required. It must be uploaded
 * to the File Cabinet before any entry-point script, which will otherwise fail at load time.
 *
 * House style is ES5 throughout — var, function, 'use strict'. This is a deliberate convention
 * for consistency across the project, not a limitation of SuiteScript 2.1. Do not modernise it.
 *
 * See docs/context.md for the design constraints this module exists to serve.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.3.0
 */
define(['N/search', 'N/error', 'N/log'], function (search, error, log) {

    'use strict';

    var VERSION = '1.3.0';

    /* ---------------------------------------------------------------------------------------
     * CONFIRMED NETSUITE IDS
     *
     * Verified against the account by Steve, 2026-08-20.
     *
     * Every value below is a SCRIPT ID. Script IDs are chosen by the developer and are identical
     * in Sandbox and Production, which is why they are safe to commit. No numeric internal ID
     * appears anywhere in this file, or in any other file in this repo — internal IDs are read at
     * runtime from the configuration record. See docs/context.md section 3.
     *
     *   Purpose                          Script ID                          Type
     *   -------------------------------- ---------------------------------- ------------------------
     *   Config custom record type        customrecord_wi_config             Custom record
     *   Config: form internal ID         custrecord_wi_form_internal_id     Integer
     *   Config: default assignee         custrecord_wi_default_assignee     List/Record -> Employee
     *   Config: default priority         custrecord_wi_default_priority     List
     *   Config: due date offset (days)   custrecord_wi_due_date_offset      Integer
     *   Task: work instruction           custevent_work_instruction_type    List/Record -> config record
     *
     * DEPRECATED — DO NOT USE:
     *
     *   custrecord_wi_default_form_type
     *
     *   This field exists in the account but is mis-built: it is a List/Record pointing at the
     *   Task record type rather than holding a form. It is being made inactive. It is named here
     *   only so that a future session does not "discover" it and switch to it believing it to be
     *   the correct source of the form. The form comes from custrecord_wi_form_internal_id.
     * ------------------------------------------------------------------------------------------ */

    /**
     * Script ID of the Work Instruction configuration custom record.
     * UI display name: "Work Instruction Configuration". Same record.
     * @type {string}
     */
    var CONFIG_RECORD_TYPE = 'customrecord_wi_config';

    /**
     * Field script IDs on the configuration record.
     * @type {Object}
     */
    var CONFIG_FIELDS = {
        /** Integer. Internal ID of the custom form the Task must open on. Read at runtime only. */
        FORM_INTERNAL_ID: 'custrecord_wi_form_internal_id',
        /** List/Record -> Employee. Used as the assignee when populated. */
        DEFAULT_ASSIGNEE: 'custrecord_wi_default_assignee',
        /** List. Read as TEXT, never as internal ID. See normalisePriority below. */
        DEFAULT_PRIORITY: 'custrecord_wi_default_priority',
        /** Integer. Days from today to the Task due date. 0 is meaningful — see parseOffsetDays. */
        DUE_DATE_OFFSET: 'custrecord_wi_due_date_offset'
    };

    /**
     * Field script IDs on the Task record. The work instruction field is written by
     * wi_ue_task_prefill.js and by nothing else — there is exactly one writer.
     * @type {Object}
     */
    var TASK_FIELDS = {
        /** List/Record -> configuration record. The searchable work instruction type. */
        WORK_INSTRUCTION_TYPE: 'custevent_work_instruction_type'
    };

    /**
     * Native Task field IDs this feature writes. Held here so that no entry-point script restates
     * a field ID — there is one place to look when a field ID needs checking.
     * @type {Object}
     */
    var TASK_NATIVE_FIELDS = {
        /** The custom form the Task is rendered on. Readable at runtime; NOT searchable. */
        CUSTOM_FORM: 'customform',
        TITLE: 'title',
        PRIORITY: 'priority',
        DUE_DATE: 'duedate',
        ASSIGNED: 'assigned',
        COMPANY: 'company',
        TRANSACTION: 'transaction'
    };

    /**
     * Native field IDs read from the source record (Opportunity or Customer).
     * @type {Object}
     */
    var SOURCE_FIELDS = {
        /** On an Opportunity: the customer the Opportunity belongs to. */
        ENTITY: 'entity',
        /** On both Opportunity and Customer: the record's own sales rep. */
        SALES_REP: 'salesrep'
    };

    /**
     * Record type IDs this feature launches from.
     * @type {Object}
     */
    var SOURCE_TYPES = {
        OPPORTUNITY: 'opportunity',
        CUSTOMER: 'customer'
    };

    /**
     * URL parameter names. 'cf' is NetSuite's own custom-form parameter, confirmed by Steve from a
     * live URL. The rest are ours, prefixed so they cannot collide with a native parameter.
     * @type {Object}
     */
    var URL_PARAMS = {
        CUSTOM_FORM: 'cf',
        CONFIG_ID: 'wi_config',
        SOURCE_TYPE: 'wi_src_type',
        SOURCE_ID: 'wi_src_id'
    };

    /**
     * Script and deployment IDs, used by url.resolveScript(). Script IDs, therefore committable.
     * @type {Object}
     */
    var SCRIPT_IDS = {
        PICKER_SUITELET: 'customscript_wi_sl_picker',
        PICKER_DEPLOYMENT: 'customdeploy_wi_sl_picker'
    };

    /**
     * Fields this feature adds to a form at runtime. Not NetSuite configuration — these exist only
     * for the life of the rendered page.
     * @type {Object}
     */
    var FORM_FIELDS = {
        /** Hidden. Carries the resolved picker URL from the user event to the client script. */
        PICKER_URL: 'custpage_wi_picker_url'
    };

    /**
     * Names of functions the client script exposes for form buttons.
     *
     * form.addButton({ functionName: ... }) takes a function NAME, never an expression: NetSuite
     * appends '()' to whatever string it is given. The value here must match the key on the object
     * returned by wi_cs_source_button.js EXACTLY, including case. See docs/context.md section 5.
     * @type {Object}
     */
    var CLIENT_FUNCTIONS = {
        OPEN_PICKER: 'openWorkInstructionPicker'
    };

    /**
     * Prefix on every log.audit and log.error title raised by this feature, so the execution log
     * can be filtered on one string.
     * @type {string}
     */
    var LOG_PREFIX = 'WI_';

    /**
     * NetSuite's native Task priority values. These are the internal IDs on the native Task
     * Priority list and are the same in every account, so they are safe to hold as literals.
     * @type {Object}
     */
    var TASK_PRIORITIES = {
        HIGH: 'HIGH',
        MEDIUM: 'MEDIUM',
        LOW: 'LOW'
    };

    /* -------------------------------------------------------------------------------------- */
    /* Helpers                                                                                 */
    /* -------------------------------------------------------------------------------------- */

    /**
     * Trims a value and returns null when it is empty. Used everywhere a NetSuite field may come
     * back as '' rather than as null.
     *
     * @param {*} raw
     * @returns {string|null}
     */
    function trimToNull(raw) {
        if (raw === null || raw === undefined) {
            return null;
        }
        var text = String(raw).replace(/^\s+|\s+$/g, '');
        return text === '' ? null : text;
    }

    /**
     * Normalises a form internal ID to a comparable string.
     *
     * The two sides arrive in different shapes: getValue('customform') returns a STRING, while
     * custrecord_wi_form_internal_id is an INTEGER field. Both are normalised here rather than
     * left to JavaScript's type coercion, which would treat a padded or decimal-suffixed form id
     * as unequal to the same id as a plain number in some comparisons and equal in others.
     *
     * @param {*} raw
     * @returns {string|null}
     */
    function normaliseFormId(raw) {
        var text = trimToNull(raw);
        if (text === null) {
            return null;
        }

        var asNumber = Number(text);
        if (isFinite(asNumber) && Math.floor(asNumber) === asNumber) {
            return String(asNumber);
        }

        return text;
    }

    /**
     * Normalises the configured priority to a native Task priority value.
     *
     * The priority column is read as TEXT rather than as an internal ID. The field type was never
     * definitively established — it may be a List/Record sourced from the native Task Priority
     * list, or a hand-built custom list. Text is the one representation that is correct either
     * way: both display "High" / "Medium" / "Low". Mapping on option internal IDs would be wrong,
     * because for a custom list those are environment-specific and would break in a second
     * account. Recorded as a deliberate decision in docs/context.md section 4.
     *
     * A blank priority is a legitimate "not configured" state and is not logged. A non-blank value
     * that does not map is logged with BOTH the raw text and the raw internal ID, so that if the
     * assumption above is ever wrong the execution log names the exact value that failed.
     *
     * @param {string} rawText - result of getText() on the priority column
     * @param {string} rawValue - result of getValue() on the priority column
     * @param {string} configName - config record name, for the log line
     * @param {string} configId - config record internal id, for the log line
     * @returns {string|null} 'HIGH' | 'MEDIUM' | 'LOW', or null to leave priority unset
     */
    function normalisePriority(rawText, rawValue, configName, configId) {
        var key = trimToNull(rawText);
        if (key === null) {
            return null;
        }
        key = key.toUpperCase();

        if (TASK_PRIORITIES.hasOwnProperty(key)) {
            return TASK_PRIORITIES[key];
        }

        log.audit({
            title: LOG_PREFIX + 'PRIORITY_UNMAPPED',
            details: 'Config "' + configName + '" (id ' + configId + '): priority text ' +
                JSON.stringify(rawText) + ' (internal id ' + JSON.stringify(rawValue) +
                ') did not map to HIGH, MEDIUM or LOW. Priority left unset.'
        });
        return null;
    }

    /**
     * Parses the due date offset. Three states, and the distinction is load-bearing:
     *
     *   a positive number  -> due date is today + that many days
     *   0                  -> due date is today. Deliberate and confirmed; several config
     *                         records use it intentionally.
     *   blank / non-numeric -> null, meaning leave the due date field alone entirely.
     *
     * Blank is tested for EXPLICITLY rather than by truthiness. 0 is falsy in JavaScript, so an
     * `if (offset)` check would silently skip the due date on exactly the records that legitimately
     * want today. Do not "simplify" this function into a truthiness check.
     *
     * @param {*} raw
     * @param {string} configName
     * @param {string} configId
     * @returns {number|null} whole number of days, or null to leave the due date alone
     */
    function parseOffsetDays(raw, configName, configId) {
        var text = trimToNull(raw);
        if (text === null) {
            return null;
        }

        var days = Number(text);
        if (!isFinite(days) || Math.floor(days) !== days) {
            log.audit({
                title: LOG_PREFIX + 'CONFIG_INCOMPLETE',
                details: 'Config "' + configName + '" (id ' + configId + '): due date offset ' +
                    JSON.stringify(raw) + ' is not a whole number. Due date left alone.'
            });
            return null;
        }

        return days;
    }

    /**
     * The search columns every config read uses, in one place so that getActiveTypes() and
     * getByTypeId() cannot drift apart.
     *
     * @returns {Array}
     */
    function configColumns() {
        return [
            search.createColumn({ name: 'internalid' }),
            search.createColumn({ name: 'name', sort: search.Sort.ASC }),
            search.createColumn({ name: CONFIG_FIELDS.FORM_INTERNAL_ID }),
            search.createColumn({ name: CONFIG_FIELDS.DEFAULT_ASSIGNEE }),
            search.createColumn({ name: CONFIG_FIELDS.DEFAULT_PRIORITY }),
            search.createColumn({ name: CONFIG_FIELDS.DUE_DATE_OFFSET })
        ];
    }

    /**
     * Maps one search result row to a config object.
     *
     * @param {Object} result
     * @returns {Object} { id, name, formInternalId, defaultAssignee, priority, dueOffsetDays }
     */
    function mapRow(result) {
        var id = result.getValue({ name: 'internalid' });
        var name = result.getValue({ name: 'name' });

        return {
            id: id,
            name: name,
            formInternalId: trimToNull(result.getValue({ name: CONFIG_FIELDS.FORM_INTERNAL_ID })),
            defaultAssignee: trimToNull(result.getValue({ name: CONFIG_FIELDS.DEFAULT_ASSIGNEE })),
            priority: normalisePriority(
                result.getText({ name: CONFIG_FIELDS.DEFAULT_PRIORITY }),
                result.getValue({ name: CONFIG_FIELDS.DEFAULT_PRIORITY }),
                name,
                id
            ),
            dueOffsetDays: parseOffsetDays(
                result.getValue({ name: CONFIG_FIELDS.DUE_DATE_OFFSET }),
                name,
                id
            )
        };
    }

    /* -------------------------------------------------------------------------------------- */
    /* Public                                                                                  */
    /* -------------------------------------------------------------------------------------- */

    /**
     * Every active configuration record, sorted by name.
     *
     * A record with no form internal ID is EXCLUDED and logged as WI_CONFIG_INCOMPLETE. It cannot
     * open a form, so listing it in the picker would produce a dead link.
     *
     * No caching. One search per page load is trivial governance and a cache would risk serving a
     * stale form ID immediately after someone edits a config record. Left out deliberately, not
     * forgotten.
     *
     * @returns {Array<Object>}
     */
    function getActiveTypes() {
        var types = [];

        search.create({
            type: CONFIG_RECORD_TYPE,
            filters: [['isinactive', 'is', 'F']],
            columns: configColumns()
        }).run().each(function (result) {
            var config = mapRow(result);

            if (config.formInternalId === null) {
                log.audit({
                    title: LOG_PREFIX + 'CONFIG_INCOMPLETE',
                    details: 'Config "' + config.name + '" (id ' + config.id + ') has no form ' +
                        'internal ID and was excluded from the picker. It cannot open a form.'
                });
                return true;
            }

            types.push(config);
            return true;
        });

        return types;
    }

    /**
     * One configuration record by internal id.
     *
     * Inactive records are NOT filtered out here. A user may have opened the picker moments before
     * a config record was deactivated, and failing their in-flight Task would be worse than
     * honouring it.
     *
     * Throws rather than returning null. A missing config at this point is always a defect — the
     * id came from a link this feature generated — and a caller that silently swallowed a null
     * would produce a Task with no work instruction type, which is the exact outcome this whole
     * feature exists to prevent.
     *
     * @param {string|number} id
     * @returns {Object} config object, shape as getActiveTypes()
     * @throws {error.SuiteScriptError} WI_CONFIG_MISSING
     */
    function getByTypeId(id) {
        var wanted = trimToNull(id);

        if (wanted === null) {
            throw error.create({
                name: LOG_PREFIX + 'CONFIG_MISSING',
                message: 'No work instruction configuration id was supplied.'
            });
        }

        var found = null;

        search.create({
            type: CONFIG_RECORD_TYPE,
            filters: [['internalid', 'anyof', wanted]],
            columns: configColumns()
        }).run().each(function (result) {
            found = mapRow(result);
            return false;
        });

        if (found === null) {
            throw error.create({
                name: LOG_PREFIX + 'CONFIG_MISSING',
                message: 'No work instruction configuration record found with internal id ' +
                    wanted + '.'
            });
        }

        return found;
    }

    /**
     * The single ACTIVE configuration record whose form internal ID matches, or null.
     *
     * This is the safety net for a Task raised outside the picker: the user still chose the right
     * form, so the work instruction type can be recovered from it.
     *
     * THREE OUTCOMES, and the middle one will look wrong to a fresh reader:
     *
     *   exactly one match  -> that config object
     *   no match           -> null, quietly. NOT an error: most Tasks in the account have nothing
     *                         to do with this feature.
     *   more than one      -> null, and WI_FORM_AMBIGUOUS at ERROR level naming every match.
     *
     * On ambiguity this deliberately does NOT pick one. Stamping a wrong work instruction type
     * silently corrupts the exact reports this feature exists to produce, and nobody would ever
     * know to look. Leaving the field blank surfaces the Task in a data-quality search and gets it
     * fixed. A visible gap beats invisible wrong data. Do not "improve" this into a first-match.
     *
     * @param {string|number} formInternalId - typically from getValue('customform'), a string
     * @returns {Object|null} config object, shape as getActiveTypes()
     */
    function getByFormId(formInternalId) {
        var wanted = normaliseFormId(formInternalId);

        if (wanted === null) {
            return null;
        }

        var matches = [];

        search.create({
            type: CONFIG_RECORD_TYPE,
            filters: [
                ['isinactive', 'is', 'F'],
                'AND',
                [CONFIG_FIELDS.FORM_INTERNAL_ID, 'equalto', wanted]
            ],
            columns: configColumns()
        }).run().each(function (result) {
            // The filter above has already narrowed the set, but it compares NetSuite-side with
            // NetSuite's own coercion rules. Re-check here against the normalised value so that
            // both sides of the comparison have been through the same function.
            var candidate = normaliseFormId(result.getValue({ name: CONFIG_FIELDS.FORM_INTERNAL_ID }));

            if (candidate === wanted) {
                matches.push(mapRow(result));
            }

            return true;
        });

        if (matches.length === 0) {
            return null;
        }

        if (matches.length > 1) {
            var named = [];
            var i;
            for (i = 0; i < matches.length; i += 1) {
                named.push('"' + matches[i].name + '" (id ' + matches[i].id + ')');
            }

            log.error({
                title: LOG_PREFIX + 'FORM_AMBIGUOUS',
                details: 'Form internal id ' + wanted + ' is claimed by ' + matches.length +
                    ' active configuration records: ' + named.join(', ') + '. The work instruction ' +
                    'type was left blank rather than guessed. Deactivate or repoint all but one.'
            });
            return null;
        }

        return matches[0];
    }

    return {
        VERSION: VERSION,
        CONFIG_RECORD_TYPE: CONFIG_RECORD_TYPE,
        CONFIG_FIELDS: CONFIG_FIELDS,
        TASK_FIELDS: TASK_FIELDS,
        TASK_NATIVE_FIELDS: TASK_NATIVE_FIELDS,
        SOURCE_FIELDS: SOURCE_FIELDS,
        SOURCE_TYPES: SOURCE_TYPES,
        URL_PARAMS: URL_PARAMS,
        SCRIPT_IDS: SCRIPT_IDS,
        FORM_FIELDS: FORM_FIELDS,
        CLIENT_FUNCTIONS: CLIENT_FUNCTIONS,
        LOG_PREFIX: LOG_PREFIX,
        TASK_PRIORITIES: TASK_PRIORITIES,
        getActiveTypes: getActiveTypes,
        getByTypeId: getByTypeId,
        getByFormId: getByFormId
    };

});
