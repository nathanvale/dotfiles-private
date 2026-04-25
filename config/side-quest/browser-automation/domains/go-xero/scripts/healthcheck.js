(function () {
  /**
   * Candidate healthcheck scaffold for go-xero.
   */
  var title = document.title || "";
  var url = window.location.href || "";
  var text = (document.body && document.body.innerText) || "";
  var loginDetected =
    /login\.xero\.com/i.test(url) ||
    /sign in|log in/i.test(title) ||
    /enter your email|enter your password/i.test(text);

  var reconcileCountMatch = text.match(/Reconcile\s*\((\d+)\)/);

  return {
    success: /go\.xero\.com/i.test(url) && !loginDetected,
    title: title,
    url: url,
    loginDetected: loginDetected,
    reconcileCount: reconcileCountMatch ? Number(reconcileCountMatch[1]) : null,
    hasWhoField: document.querySelector('input[placeholder*="contact"]') !== null,
    hasWhatField: document.querySelector('input[placeholder*="account"]') !== null,
  };
})();
