(function () {
  /**
   * Candidate response extraction scaffold for api-explorer-xero.
   *
   * Reads the visible response body directly from the DOM. This is a
   * conservative scaffold and has not yet been exercised against the live
   * API Explorer response panel via /browse.
   */
  var candidates = Array.from(
    document.querySelectorAll("pre, code, textarea[readonly]")
  ).map(function (node) {
    return {
      text: (node.value || node.innerText || node.textContent || "").trim(),
      source: node.tagName.toLowerCase(),
    };
  });

  var response = candidates.find(function (entry) {
    return entry.text.length > 0 && (/^\{/.test(entry.text) || /^\[/.test(entry.text));
  });

  if (!response) {
    return { success: false, message: "response body not found" };
  }

  return {
    success: true,
    source: response.source,
    bytes: response.text.length,
    text: response.text,
  };
})();
