/* Native metadata only. Never enter AXWebArea or use Chrome's scripting API. */
function run(argv) {
    "use strict";
    var deadline = Date.now() + 45000;
    var original = null;
    var baseline = null;
    var process = null;
    var display = argv[0];
    var requestedURL = argv[1];

    function refuse(reason) { throw {laneReason: reason}; }
    function comparisonURL(value) {
        // Chrome serializes an empty HTTP(S) path as '/'. Preserve every other
        // byte, including query, fragment, and encoded path distinctions.
        return value.replace(/^(https?:\/\/[^/?#]+)(?=[?#]|$)/i, "$1/");
    }
    function checkTime() {
        if (Date.now() >= deadline) refuse("native_deadline");
    }
    function attribute(element, name) {
        checkTime();
        try { return element.attributes.byName(name).value(); }
        catch (_) { return null; }
    }
    function profileMatches(title) {
        if (typeof title !== "string") return false;
        var marker = " - Google Chrome \u2013 ";
        var index = title.lastIndexOf(marker);
        if (index < 0) return false;
        var suffix = title.slice(index + marker.length);
        return suffix === display ||
            (suffix.length > display.length + 3 && suffix.endsWith(" (" + display + ")"));
    }
    function profileWindow() {
        checkTime();
        var windows = process.windows();
        if (windows.length > 40) refuse("profile_window_ambiguous");
        var matches = windows.filter(function (window) {
            return profileMatches(attribute(window, "AXTitle"));
        });
        if (matches.length !== 1) {
            refuse(matches.length ? "profile_window_ambiguous" : "profile_window_unavailable");
        }
        if (attribute(matches[0], "AXMinimized") !== false) refuse("profile_window_unavailable");
        return matches[0];
    }
    function identifier(element) {
        var value = attribute(element, "ChromeAXNodeId");
        if (typeof value !== "number" && typeof value !== "string") refuse("tab_inventory_unavailable");
        if (String(value).length === 0) refuse("tab_inventory_unavailable");
        return String(value);
    }
    function inventory() {
        var window = profileWindow();
        var tabs = [];
        var walked = 0;
        var positionMode = null;
        // Only structural Chrome UI is walked. AXWebArea children are never
        // fetched, including when the currently selected page is a login page.
        function walk(element, depth, inTabGroup) {
            checkTime();
            if (++walked > 300 || depth > 14) refuse("tab_inventory_unavailable");
            var role = attribute(element, "AXRole");
            if (role === "AXWebArea") return;
            if (role === "AXRadioButton" && inTabGroup) {
                const position = attribute(element, "AXARIAPosInSet");
                const size = attribute(element, "AXARIASetSize");
                const metadataAbsent = position === null && size === null;
                const metadataPresent = Number.isInteger(position) && Number.isInteger(size) &&
                    position >= 1 && size >= 1 && size <= 40 && position <= size;
                if (!metadataAbsent && !metadataPresent) {
                    refuse("tab_inventory_unavailable");
                }
                const currentMode = metadataPresent ? "explicit" : "structural";
                if (positionMode !== null && positionMode !== currentMode) refuse("tab_inventory_unavailable");
                positionMode = currentMode;
                tabs.push({element: element, id: identifier(element), position: position,
                    size: size, selected: attribute(element, "AXValue")});
                return;
            }
            // Leaf controls cannot contain the tab strip. Do not traverse
            // address fields, buttons, text, menus, or their values.
            if (["AXWindow", "AXGroup", "AXTabGroup", "AXSplitGroup", "AXScrollArea"].indexOf(role) < 0) return;
            var children = element.uiElements();
            if (children.length > 100) refuse("tab_inventory_unavailable");
            children.forEach(function (child) {
                walk(child, depth + 1, inTabGroup || role === "AXTabGroup");
            });
        }
        walk(window, 0, false);
        if (!tabs.length || tabs.length > 40) refuse("tab_inventory_unavailable");
        // Chrome 152 omits the ARIA set position attributes from otherwise
        // complete tab buttons. In that shape, uiElements() order is the only
        // structural order; the stable ID signature still detects changes.
        if (positionMode === "explicit") tabs.sort(function (a, b) { return a.position - b.position; });
        var ids = {};
        tabs.forEach(function (tab, index) {
            if ((positionMode === "explicit" &&
                    (tab.position !== index + 1 || tab.size !== tabs.length)) || ids[tab.id]) {
                refuse("tab_inventory_unavailable");
            }
            ids[tab.id] = true;
        });
        var selected = tabs.filter(function (tab) { return tab.selected === 1 || tab.selected === true; });
        if (selected.length !== 1) refuse("tab_selection_unavailable");
        return {window: window, tabs: tabs, selected: selected[0].id,
            signature: tabs.map(function (tab) { return tab.id; }).join(",")};
    }
    function stableInventory() {
        var current = inventory();
        if (baseline !== null && current.signature !== baseline) refuse("tab_inventory_changed");
        return current;
    }
    function select(id, before) {
        // Reuse the inventory verified by the prior metadata read. The fresh
        // post-selection inventory still detects any intervening tab change.
        before = before || stableInventory();
        if (before.signature !== baseline) refuse("tab_inventory_changed");
        var tab = before.tabs.filter(function (candidate) { return candidate.id === id; })[0];
        if (!tab) refuse("tab_inventory_changed");
        if (before.selected !== id) tab.element.actions.byName("AXPress").perform();
        var after = stableInventory();
        if (after.selected !== id) refuse("tab_selection_unavailable");
        return after;
    }
    function documentURL(current) {
        // Read only the addressed window's document metadata after its selected
        // tab and profile have been freshly checked. Never fall back to DOM.
        var tab = current.tabs.filter(function (candidate) { return candidate.id === current.selected; })[0];
        if (!tab) refuse("tab_inventory_changed");
        if (!profileMatches(attribute(current.window, "AXTitle")) ||
                attribute(current.window, "AXMinimized") !== false) {
            refuse("profile_window_changed");
        }
        var value = attribute(current.window, "AXDocument");
        // Internal Chrome pages are readable non-matches, not permission to
        // skip an unknown tab. Keep every address transient and host-side.
        if (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*:/i.test(value)) refuse("tab_url_unavailable");
        var selectedValue = attribute(tab.element, "AXValue");
        if (selectedValue !== 1 && selectedValue !== true) {
            refuse("tab_selection_unavailable");
        }
        if (attribute(current.window, "AXDocument") !== value) refuse("tab_url_unavailable");
        return value;
    }
    function restore() {
        if (original !== null && Date.now() < deadline) {
            try { select(original); } catch (_) { /* Never guess a changed tab. */ }
        }
    }

    try {
        if (argv.length !== 2 || !display || !requestedURL) refuse("invalid_request");
        const events = Application("System Events");
        const processes = events.applicationProcesses.whose({bundleIdentifier: "com.google.Chrome"})();
        if (!processes.length) return JSON.stringify({state: "absent", reason: "chrome_not_running"});
        if (processes.length !== 1) refuse("chrome_process_ambiguous");
        process = processes[0];
        const initial = inventory();
        original = initial.selected;
        baseline = initial.signature;
        const matches = [];
        let current = initial;
        initial.tabs.forEach(function (tab) {
            current = select(tab.id, current);
            if (comparisonURL(documentURL(current)) === comparisonURL(requestedURL)) matches.push(tab.id);
        });
        current = stableInventory();
        if (matches.length > 1) refuse("exact_tab_ambiguous");
        if (!matches.length) {
            select(original, current);
            return JSON.stringify({state: "absent", reason: "exact_tab_absent"});
        }
        const matched = select(matches[0], current);
        if (comparisonURL(documentURL(matched)) !== comparisonURL(requestedURL)) refuse("tab_url_unavailable");
        matched.window.actions.byName("AXRaise").perform();
        process.frontmost = true;
        if (comparisonURL(documentURL(select(matches[0], matched))) !== comparisonURL(requestedURL)) refuse("tab_url_unavailable");
        return JSON.stringify({state: "reused", reason: "exact_tab_reused"});
    } catch (error) {
        restore();
        return JSON.stringify({state: "refused", reason: error.laneReason || "native_access_unavailable"});
    }
}
