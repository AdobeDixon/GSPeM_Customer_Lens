// Injected at document_start — before any page scripts run.
// Always hides <brand-management-app> via CSS.  The main contentScript.js
// (document_idle) removes the cloak once filtering is complete or the filter
// is ALL.  On non-brands pages the element doesn't exist so the rule is inert.
(function () {
  try {
    var s = document.createElement('style');
    s.id = 'gs4pm-brand-host-cloak';
    s.textContent = 'brand-management-app:not(.gs4pm-filtered){opacity:0!important}';
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
