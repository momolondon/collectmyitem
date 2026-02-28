/**
 * Shared UK postcode validation helpers.
 * Used by details.html and quote.html.
 */
(function () {
  "use strict";

  function cleanPostcode(pc) {
    return String(pc || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
  }

  function isValidPostcode(pc) {
    const s = cleanPostcode(pc);
    return /^[A-Z]{1,2}\d[A-Z0-9]?\d[A-Z]{2}$/.test(s);
  }

  function formatPostcodeForDisplay(pc) {
    const s = cleanPostcode(pc);
    if (s.length >= 5 && s.charAt(s.length - 4) !== " ") {
      return s.slice(0, -3) + " " + s.slice(-3);
    }
    return s;
  }

  window.cleanPostcode = cleanPostcode;
  window.isValidPostcode = isValidPostcode;
  window.formatPostcodeForDisplay = formatPostcodeForDisplay;
})();
