/**
 * wi_cs_source_button.js
 *
 * Client-side handler for the "Create Work Instruction" button drawn by wi_ue_source_button.js.
 *
 * WHY THIS FILE EXISTS
 *
 * form.addButton({ functionName: ... }) takes a function NAME, never an expression. NetSuite
 * appends '()' to whatever string it is given and invokes the result. Passing an inline expression
 * such as "window.location.href='...'" makes NetSuite evaluate it to a string and then call that
 * string, producing:
 *
 *   Uncaught TypeError: "<the whole resolved Suitelet URL>" is not a function
 *
 * The exact console output is recorded in docs/context.md section 5.
 *
 * So the button names this function instead, and the URL travels in a hidden field on the form.
 * See docs/context.md section 5.
 *
 * The exported key openWorkInstructionPicker must match CLIENT_FUNCTIONS.OPEN_PICKER in
 * wi_lib_config.js exactly, including case. It is a literal here because ES5 object literals
 * cannot use a computed key.
 *
 * This script is attached by the user event via form.clientScriptModulePath. It needs no script
 * record and no deployment record — only a File Cabinet upload into this same folder.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */
define(['N/currentRecord', 'N/log', './lib/wi_lib_config'],
    function (currentRecord, log, wiConfig) {

        'use strict';

        var VERSION = '1.0.0';

        /**
         * Required entry point. NetSuite will not load a client script without one. Nothing to do
         * on page init — the button handler does all the work.
         *
         * @returns {void}
         */
        function pageInit() {
            return;
        }

        /**
         * Navigates to the picker Suitelet.
         *
         * NetSuite calls this by name, with no arguments — it appends '()' itself. The URL was
         * resolved server-side by url.resolveScript() and placed in a hidden field, so nothing
         * account-specific is built here.
         *
         * @returns {void}
         */
        function openWorkInstructionPicker() {
            try {
                var record = currentRecord.get();
                var target = record.getValue({ fieldId: wiConfig.FORM_FIELDS.PICKER_URL });

                if (!target) {
                    // Navigating to an empty value would land the user on a blank page with no
                    // explanation. Say so instead.
                    log.error({
                        title: wiConfig.LOG_PREFIX + 'BUTTON_URL_MISSING',
                        details: 'The hidden picker URL field was empty on ' + record.type +
                            ' id ' + record.id + '. The button cannot navigate.'
                    });
                    alert('The work instruction picker could not be opened. ' +
                        'Please reload the page, and tell an administrator if it happens again.');
                    return;
                }

                window.location.href = target;

            } catch (e) {
                log.error({
                    title: wiConfig.LOG_PREFIX + 'BUTTON_CLICK_FAILED',
                    details: (e.name || '') + ': ' + (e.message || e)
                });
                alert('The work instruction picker could not be opened. ' +
                    'Please reload the page, and tell an administrator if it happens again.');
            }
        }

        return {
            VERSION: VERSION,
            pageInit: pageInit,
            openWorkInstructionPicker: openWorkInstructionPicker
        };

    });
