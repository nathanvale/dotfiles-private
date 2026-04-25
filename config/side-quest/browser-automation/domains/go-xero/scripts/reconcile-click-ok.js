(function () {
  /**
   * Candidate reconcile-click-ok scaffold for go-xero.
   *
   * Optional input:
   *   window.__XERO_RECONCILE_ARGS__ = { lineIndex: 0 }
   */
  var args = window.__XERO_RECONCILE_ARGS__ || {};
  var lineIndex = typeof args.lineIndex === "number" ? args.lineIndex : 0;

  var countMatch = ((document.body && document.body.innerText) || "").match(/Reconcile\s*\((\d+)\)/);
  var countBefore = countMatch ? Number(countMatch[1]) : null;

  var okButtons = Array.from(document.querySelectorAll("button")).filter(function (button) {
    var label = (button.innerText || button.textContent || "").trim();
    return label === "OK" && !button.disabled;
  });

  if (okButtons.length === 0) {
    return { success: false, message: "no visible enabled OK button found" };
  }

  if (lineIndex < 0 || lineIndex >= okButtons.length) {
    return {
      success: false,
      message: "requested lineIndex is outside visible OK button range",
      visibleCount: okButtons.length,
    };
  }

  okButtons[lineIndex].click();
  return {
    success: true,
    clickedLineIndex: lineIndex,
    visibleOkButtons: okButtons.length,
    reconcileCountBefore: countBefore,
  };
})();
