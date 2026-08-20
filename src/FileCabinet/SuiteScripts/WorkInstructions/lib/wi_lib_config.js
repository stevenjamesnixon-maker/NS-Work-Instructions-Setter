/**
 * wi_lib_config.js
 *
 * Shared configuration module for the Work Instructions feature. This is the only module that
 * knows the script IDs of the Work Instruction configuration record and its fields — every other
 * script imports them from here rather than restating them.
 *
 * Shared AMD module: no script record and no deployment record is required. It must be uploaded
 * to the File Cabinet before any entry-point script, which will otherwise fail at load time.
 *
 * See docs/context.md for the design constraints this module exists to serve.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define([], () => {

    const VERSION = '1.0.0';

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
     * @type {string}
     */
    const CONFIG_RECORD_TYPE = 'customrecord_wi_config';

    /**
     * Field script IDs on the configuration record.
     * @type {Object<string, string>}
     */
    const CONFIG_FIELDS = {
        /** Integer. Internal ID of the custom form the Task must open on. Read at runtime only. */
        FORM_INTERNAL_ID: 'custrecord_wi_form_internal_id',
        /** List/Record -> Employee. Used as the assignee when populated. */
        DEFAULT_ASSIGNEE: 'custrecord_wi_default_assignee',
        /** List. Raw stored value — must be normalised before use. See docs/context.md section 0. */
        DEFAULT_PRIORITY: 'custrecord_wi_default_priority',
        /** Integer. Number of days from creation to the Task due date. */
        DUE_DATE_OFFSET: 'custrecord_wi_due_date_offset'
    };

    /**
     * Field script IDs on the Task record.
     * @type {Object<string, string>}
     */
    const TASK_FIELDS = {
        /** List/Record -> configuration record. The searchable work instruction type. */
        WORK_INSTRUCTION_TYPE: 'custevent_work_instruction_type'
    };

    /**
     * Prefix on every log.audit and log.error title raised by this feature, so the execution log
     * can be filtered on one string.
     * @type {string}
     */
    const LOG_PREFIX = 'WI_';

    return {
        VERSION,
        CONFIG_RECORD_TYPE,
        CONFIG_FIELDS,
        TASK_FIELDS,
        LOG_PREFIX
    };

});
