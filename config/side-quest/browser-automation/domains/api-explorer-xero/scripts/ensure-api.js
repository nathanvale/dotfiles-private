(function () {
  /**
   * Candidate ensure-api scaffold for api-explorer-xero.
   *
   * Requires:
   *   window.__XERO_TARGET_API__ = "Finance" | "Accounting" | "<exact label>"
   *
   * Caller should inject the target API before eval and perform any waits
   * needed after the click sequence.
   */
  var target = window.__XERO_TARGET_API__;
  if (!target) {
    return { success: false, message: "window.__XERO_TARGET_API__ is not set" };
  }

  var buttonLabels = Array.from(document.querySelectorAll("button")).map(function (button) {
    return (button.innerText || button.textContent || "").trim();
  });

  var normalizedTarget = target.toLowerCase();
  var selectedButton = buttonLabels.find(function (label) {
    return label.toLowerCase().indexOf(normalizedTarget) !== -1 && /api/i.test(label);
  });

  if (selectedButton && selectedButton.toLowerCase().indexOf("select api") === -1) {
    return {
      success: true,
      changed: false,
      currentApi: selectedButton,
      message: "target API already selected",
    };
  }

  var trigger = Array.from(document.querySelectorAll("button")).find(function (button) {
    var label = (button.innerText || button.textContent || "").trim();
    return label === "Select API" || /Xero .* API/i.test(label);
  });

  if (!trigger) {
    return { success: false, message: "API dropdown trigger not found" };
  }

  trigger.click();

  var option = Array.from(document.querySelectorAll("button")).find(function (button) {
    var label = (button.innerText || button.textContent || "").trim();
    return label.toLowerCase().indexOf(normalizedTarget) !== -1 && /api/i.test(label);
  });

  if (!option) {
    return {
      success: false,
      message: "target API option not found after opening dropdown",
      availableButtons: buttonLabels,
    };
  }

  option.click();
  return {
    success: true,
    changed: true,
    targetApi: target,
    message: "clicked target API option",
  };
})();
