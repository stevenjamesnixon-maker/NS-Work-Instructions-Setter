/**
 * wi_sl_picker.js
 *
 * The work instruction picker. Lists the active work instruction types as links; clicking one
 * opens a new Task on that type's custom form.
 *
 * This is the only place the custom form is chosen, and it is chosen BEFORE the Task record
 * exists. Nothing may switch the form once the Task page has rendered — see docs/context.md
 * section 0, trap 2.
 *
 * GET only. There is no submit step: one click is the entire interaction.
 *
 * The picker normally runs inside a small popup opened by wi_cs_source_button.js. Clicking a work
 * instruction opens the Task in a FULL NEW TAB and then closes the popup, in that order, leaving
 * the source record untouched in the original tab.
 *
 * This Suitelet must be deployed with Available Without Login: No.
 *
 * House style is ES5 throughout — var, function, 'use strict'. Deliberate. Do not modernise.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * @version 1.1.0
 */
define(['N/ui/serverWidget', 'N/url', 'N/log', './lib/wi_lib_config'],
    function (serverWidget, url, log, wiConfig) {

        'use strict';

        var VERSION = '1.1.0';

        var PAGE_TITLE = 'Create Work Instruction';

        /**
         * Hook for the click handler injected below. Anchors carry a real href and target="_blank"
         * as well, so if the injected script does not run the Task still opens in a new tab — only
         * the popup-closing is lost.
         * @type {string}
         */
        var LINK_CLASS = 'wi-instruction-link';

        /**
         * Escapes a value for inclusion in HTML text or an attribute.
         *
         * @param {*} raw
         * @returns {string}
         */
        function escapeHtml(raw) {
            if (raw === null || raw === undefined) {
                return '';
            }
            return String(raw)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        /**
         * Appends query parameters to a URL that NetSuite generated.
         *
         * The base URL is always produced by an N/url call, never hand-built — that is the part
         * that is account-specific. Only the query string is assembled here.
         *
         * @param {string} base
         * @param {Object} params
         * @returns {string}
         */
        function appendParams(base, params) {
            var pairs = [];
            var key;

            for (key in params) {
                if (params.hasOwnProperty(key) && params[key] !== null &&
                    params[key] !== undefined && params[key] !== '') {
                    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
                }
            }

            if (pairs.length === 0) {
                return base;
            }

            return base + (base.indexOf('?') === -1 ? '?' : '&') + pairs.join('&');
        }

        /**
         * Builds the URL that opens a new Task on the given work instruction's custom form.
         *
         * The work instruction field is deliberately NOT passed here. wi_ue_task_prefill.js sets
         * it, so there is exactly one writer of that field.
         *
         * @param {Object} config - a config object from wi_lib_config
         * @param {string} sourceType
         * @param {string} sourceId
         * @returns {string}
         */
        function buildTaskUrl(config, sourceType, sourceId) {
            // EDIT_TASK is NetSuite's own task link for "new Task". Using it keeps the account
            // specific part of the URL out of this file. VERIFY IN SANDBOX — if this link id is
            // wrong the picker links will 404, which is loud and immediate rather than silent.
            var base = url.resolveTaskLink({ id: 'EDIT_TASK' });

            var params = {};
            params[wiConfig.URL_PARAMS.CUSTOM_FORM] = config.formInternalId;
            params[wiConfig.URL_PARAMS.CONFIG_ID] = config.id;
            params[wiConfig.URL_PARAMS.SOURCE_TYPE] = sourceType;
            params[wiConfig.URL_PARAMS.SOURCE_ID] = sourceId;

            return appendParams(base, params);
        }

        /**
         * Client-side click handler, injected into the rendered page.
         *
         * Two things happen on a click, IN THIS ORDER:
         *
         *   1. the Task opens in a new browser tab
         *   2. the popup closes
         *
         * The order matters: closing the window first can cancel the pending navigation in some
         * browsers.
         *
         * Two guards:
         *
         *   - The window is closed ONLY when window.opener exists. The picker can legitimately be
         *     reached directly by URL, and is reached that way whenever a popup was blocked. In
         *     those cases it is an ordinary tab, and closing it would shut the user's tab under
         *     them.
         *   - If window.open is blocked, the click navigates in place instead of doing nothing.
         *
         * If this script does not run at all, the anchors still carry href and target="_blank", so
         * the Task opens in a new tab regardless — only the popup-closing is lost.
         *
         * @returns {string}
         */
        function clickHandlerScript() {
            return '<script type="text/javascript">' +
                '(function () {' +
                '    "use strict";' +
                '    var links = document.querySelectorAll("a.' + LINK_CLASS + '");' +
                '    var i;' +
                '    function onLinkClick(e) {' +
                '        var href = this.href;' +
                '        if (e && e.preventDefault) { e.preventDefault(); }' +
                '        var opened = window.open(href, "_blank");' +
                '        if (!opened) {' +
                '            window.location.href = href;' +
                '            return false;' +
                '        }' +
                '        if (window.opener) { window.close(); }' +
                '        return false;' +
                '    }' +
                '    for (i = 0; i < links.length; i += 1) {' +
                '        links[i].addEventListener("click", onLinkClick, false);' +
                '    }' +
                '}());' +
                '<' + '/script>';
        }

        /**
         * @param {Array<Object>} types
         * @param {string} sourceType
         * @param {string} sourceId
         * @returns {string}
         */
        function renderList(types, sourceType, sourceId) {
            var html = ['<div style="padding:12px 0;">',
                '<p style="margin:0 0 12px 0;">Choose the work instruction to raise.</p>',
                '<ul style="list-style:none;margin:0;padding:0;">'];
            var i;

            for (i = 0; i < types.length; i += 1) {
                html.push(
                    '<li style="margin:0 0 8px 0;">' +
                    '<a class="' + LINK_CLASS + '" target="_blank" href="' +
                    escapeHtml(buildTaskUrl(types[i], sourceType, sourceId)) + '">' +
                    escapeHtml(types[i].name) +
                    '</a></li>'
                );
            }

            html.push('</ul></div>');
            html.push(clickHandlerScript());
            return html.join('');
        }

        /**
         * Shown when there is nothing to pick. Never render an empty list, and never fall through
         * to a default form — a Task raised on the wrong form is the failure this feature exists
         * to prevent.
         *
         * @returns {string}
         */
        function renderEmpty() {
            return '<div style="padding:12px 0;">' +
                '<p>No active work instruction types are configured.</p>' +
                '<p>Ask an administrator to add or activate a Work Instruction Configuration ' +
                'record with a form internal ID before raising work instructions.</p>' +
                '</div>';
        }

        /**
         * @param {Object} context
         * @param {Object} context.request
         * @param {Object} context.response
         * @returns {void}
         */
        function onRequest(context) {
            if (context.request.method !== 'GET') {
                return;
            }

            var form = serverWidget.createForm({ title: PAGE_TITLE });
            var body = form.addField({
                id: 'custpage_wi_picker_body',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });

            try {
                var sourceType = context.request.parameters[wiConfig.URL_PARAMS.SOURCE_TYPE] || '';
                var sourceId = context.request.parameters[wiConfig.URL_PARAMS.SOURCE_ID] || '';
                var types = wiConfig.getActiveTypes();

                body.defaultValue = types.length === 0
                    ? renderEmpty()
                    : renderList(types, sourceType, sourceId);

            } catch (e) {
                log.error({
                    title: wiConfig.LOG_PREFIX + 'PICKER_FAILED',
                    details: 'Could not render the work instruction picker. ' +
                        (e.name || '') + ': ' + (e.message || e)
                });

                body.defaultValue = '<div style="padding:12px 0;">' +
                    '<p>The work instruction list could not be loaded.</p>' +
                    '<p>Please try again, and tell an administrator if it happens twice. ' +
                    'The execution log will contain an entry beginning ' +
                    escapeHtml(wiConfig.LOG_PREFIX) + '.</p></div>';
            }

            context.response.writePage(form);
        }

        return {
            VERSION: VERSION,
            onRequest: onRequest
        };

    });
