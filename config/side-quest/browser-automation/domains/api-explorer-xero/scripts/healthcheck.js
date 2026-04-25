(function () {
  /**
   * Candidate healthcheck scaffold for api-explorer-xero.
   *
   * Return shape:
   *   {
   *     success: boolean,
   *     title: string,
   *     url: string,
   *     loginDetected: boolean,
   *     tenantVisible: boolean,
   *     apiButtons: string[],
   *     selectedApiHint: string | null
   *   }
   */
  var title = document.title || "";
  var url = window.location.href || "";
  var text = (document.body && document.body.innerText) || "";
  var loginDetected =
    /login\.xero\.com/i.test(url) ||
    /sign in|log in/i.test(title) ||
    /enter your email|enter your password/i.test(text);

  var apiButtons = Array.from(document.querySelectorAll("button"))
    .map(function (button) {
      return (button.innerText || button.textContent || "").trim();
    })
    .filter(function (label) {
      return /Select API|Xero .* API/i.test(label);
    });

  var selectedApiHint =
    apiButtons.find(function (label) {
      return /Xero .* API/i.test(label) && !/^Select API$/i.test(label);
    }) || null;

  return {
    success: title.indexOf("API Explorer") !== -1 && !loginDetected,
    title: title,
    url: url,
    loginDetected: loginDetected,
    tenantVisible: /Arthur & B Consulting|Tenant/i.test(text),
    apiButtons: apiButtons,
    selectedApiHint: selectedApiHint,
  };
})();
