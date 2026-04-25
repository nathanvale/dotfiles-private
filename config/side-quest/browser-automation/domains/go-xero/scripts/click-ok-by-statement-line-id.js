/**
 * click-ok-by-statement-line-id.js
 *
 * Candidate script (discovered in run xero-cli-reconcile-q1-fy26-2026-04-07-004).
 *
 * Clicks the OK button for a specific statement line on the Xero BankRec page.
 *
 * Background: `agent-browser click @eN` does NOT trigger the ExtJS reconciliation
 * handler on the OK button (G-009). The correct method is to target the
 * <a class="okayButton"> element inside the statement line's DOM container via
 * `div.line[id="sl{statementLineId}"] a.okayButton` and call .focus(); .click()
 * directly via eval.
 *
 * The statement line's DOM ID is `sl` + the statementLineId with hyphens stripped.
 * E.g. statementLineId `22cdec92-e0b4-4884-bdb5-db88ed304352` → DOM id `sl22cdec92e0b44884bdb5db88ed304352`
 *
 * Usage: Replace STATEMENT_LINE_ID_HERE with the target statementLineId (with hyphens).
 *
 * Returns: string describing result ('clicked: <lineId>' or 'error: <reason>')
 *
 * state: candidate
 * allowed_flows: reconcile-click-ok, reconcile-fill, reconcile-clear-and-fill, reconcile-batch
 */
(function(statementLineId) {
  var domId = 'sl' + statementLineId.replace(/-/g, '');
  var selector = 'div.line[id="' + domId + '"] a.okayButton';
  var btn = document.querySelector(selector);

  if (!btn) {
    var allLines = document.querySelectorAll('div.line[id]');
    return 'error: okayButton not found for statementLineId=' + statementLineId + ' (domId=' + domId + '). Total .line divs: ' + allLines.length;
  }

  btn.scrollIntoView({ behavior: 'instant', block: 'center' });
  btn.focus();
  btn.click();

  return 'clicked: ' + statementLineId;
})('STATEMENT_LINE_ID_HERE');
