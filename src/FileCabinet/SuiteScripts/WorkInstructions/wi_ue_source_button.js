/**
 * wi_ue_source_button.js
 *
 * Adds a "Create Work Instruction" button to the Opportunity and Customer records. The button
 * opens the picker Suitelet, which is where the work instruction — and therefore the Task's custom
 * form — is chosen, before the Task exists.
 *
 * One script record, two deployments: Opportunity and Customer.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/url', 'N/runtime', 'N/log', './lib/wi_lib_config'], function (url, runtime, log, wiConfig) {

    'use strict';

    var VERSION = '1.0.0';

    var BUTTON_ID = 'custpage_wi_create_instruction';
    var BUTTON_LABEL = 'Create Work Instruction';

    /**
     * @param {Object} context
     * @param {Object} context.form
     * @param {Object} context.newRecord
     * @param {string} context.type
     * @returns {void}
     */
    function beforeLoad(context) {
        try {
            // VIEW only. On create and edit there is no saved record to hang a work instruction
            // off, and the button would have nothing to pass to the picker.
            if (context.type !== context.UserEventType.VIEW) {
                return;
            }

            // User Interface only. A CSV import or a web service call has no form to draw on.
            if (runtime.executionContext !== runtime.ContextType.USER_INTERFACE) {
                return;
            }

            var sourceType = context.newRecord.type;
            var sourceId = context.newRecord.id;

            if (!sourceId) {
                return;
            }

            // resolveScript builds the account-correct URL. Never hand-build one — a hand-built
            // URL embeds the account-specific host and the script's internal id.
            var params = {};
            params[wiConfig.URL_PARAMS.SOURCE_TYPE] = sourceType;
            params[wiConfig.URL_PARAMS.SOURCE_ID] = sourceId;

            var pickerUrl = url.resolveScript({
                scriptId: wiConfig.SCRIPT_IDS.PICKER_SUITELET,
                deploymentId: wiConfig.SCRIPT_IDS.PICKER_DEPLOYMENT,
                params: params
            });

            context.form.addButton({
                id: BUTTON_ID,
                label: BUTTON_LABEL,
                functionName: "window.location.href='" + pickerUrl + "'"
            });

        } catch (e) {
            // A record that will not open because a button could not be drawn is far worse than a
            // missing button. Log and return.
            log.error({
                title: wiConfig.LOG_PREFIX + 'BUTTON_FAILED',
                details: 'Could not add the work instruction button to ' +
                    (context && context.newRecord ? context.newRecord.type : 'unknown') +
                    ' id ' + (context && context.newRecord ? context.newRecord.id : 'unknown') +
                    '. ' + (e.name || '') + ': ' + (e.message || e)
            });
        }
    }

    return {
        VERSION: VERSION,
        beforeLoad: beforeLoad
    };

});
