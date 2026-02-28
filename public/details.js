/**
 * Details page (Step 2): Load quote from sessionStorage, show price summary, collect customer details.
 * POST to /create-checkout-session with quote + customer details.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "collectMyItemQuote";

  const el = {
    priceTotal: document.getElementById("priceTotal"),
    priceDeposit: document.getElementById("priceDeposit"),
    priceRemaining: document.getElementById("priceRemaining"),
    form: document.getElementById("detailsForm"),
    customerName: document.getElementById("customerName"),
    customerPhone: document.getElementById("customerPhone"),
    customerEmail: document.getElementById("customerEmail"),
    notes: document.getElementById("notes"),
    payDepositBtn: document.getElementById("payDepositBtn"),
    errorSection: document.getElementById("errorSection"),
    errorMessage: document.getElementById("errorMessage"),
    customerNameError: document.getElementById("customerName-error"),
    customerPhoneError: document.getElementById("customerPhone-error"),
  };

  let quote = null;

  function loadQuote() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function redirectToQuote() {
    window.location.replace("quote.html");
  }

  function showError(msg) {
    if (el.errorSection) el.errorSection.hidden = false;
    if (el.errorMessage) el.errorMessage.textContent = msg || "";
  }

  function clearError() {
    if (el.errorSection) el.errorSection.hidden = true;
    if (el.errorMessage) el.errorMessage.textContent = "";
  }

  /** UK mobile: 07xxx xxxxxx or +447xxxxxxxxx — 11 digits after +44 or starting 07 */
  function isValidUKPhone(str) {
    const s = String(str || "").trim().replace(/\s+/g, "");
    if (!s) return false;
    if (/^\+447\d{9}$/.test(s)) return true;
    if (/^07\d{9}$/.test(s)) return true;
    return false;
  }

  function validateForm() {
    const name = (el.customerName?.value || "").trim();
    const phone = (el.customerPhone?.value || "").trim();

    if (el.customerNameError) el.customerNameError.textContent = "";
    if (el.customerPhoneError) el.customerPhoneError.textContent = "";

    if (!name) {
      if (el.customerNameError) el.customerNameError.textContent = "Name is required.";
      el.customerName?.focus();
      return false;
    }

    if (!isValidUKPhone(phone)) {
      if (el.customerPhoneError) el.customerPhoneError.textContent = "Please enter a valid UK mobile number (e.g. 07700 900123).";
      el.customerPhone?.focus();
      return false;
    }

    return true;
  }

  function renderPriceSummary() {
    const r = quote?.result;
    if (!r || typeof r.total !== "number") return;

    const total = Number(r.total);
    const deposit = Number(r.deposit ?? Math.round(total * 0.25));
    const remaining = Number(r.remaining ?? total - deposit);

    if (el.priceTotal) el.priceTotal.textContent = "£" + total.toFixed(0);
    if (el.priceDeposit) el.priceDeposit.textContent = "£" + deposit.toFixed(0);
    if (el.priceRemaining) el.priceRemaining.textContent = "£" + remaining.toFixed(0);
  }

  function onSubmit(e) {
    e.preventDefault();
    clearError();

    if (!validateForm()) return;
    if (!quote) {
      showError("Quote data missing. Please start again from the quote page.");
      return;
    }

    const payload = {
      ...quote.payload,
      quotedTotal: quote.result.total,
      quotedDeposit: quote.result.deposit,
      quotedRemaining: quote.result.remaining,
      customerName: (el.customerName?.value || "").trim(),
      customerPhone: (el.customerPhone?.value || "").trim(),
      customerEmail: (el.customerEmail?.value || "").trim(),
      notes: (el.notes?.value || "").trim(),
      // Backward compat for server
      name: (el.customerName?.value || "").trim(),
      phone: (el.customerPhone?.value || "").trim(),
      email: (el.customerEmail?.value || "").trim(),
    };

    if (el.payDepositBtn) {
      el.payDepositBtn.disabled = true;
      el.payDepositBtn.textContent = "Redirecting to payment…";
    }

    fetch("/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body }; }); })
      .then(function (out) {
        if (out.ok && out.body?.url) {
          window.location.href = out.body.url;
          return;
        }
        showError(out.body?.error || "Could not start payment. Please try again.");
        if (el.payDepositBtn) {
          el.payDepositBtn.disabled = false;
          el.payDepositBtn.textContent = "Pay deposit";
        }
      })
      .catch(function (err) {
        showError(err.message || "Network error. Please try again.");
        if (el.payDepositBtn) {
          el.payDepositBtn.disabled = false;
          el.payDepositBtn.textContent = "Pay deposit";
        }
      });
  }

  // Init
  quote = loadQuote();
  if (!quote || !quote.payload || !quote.result) {
    redirectToQuote();
    return;
  }

  renderPriceSummary();
  if (el.form) el.form.addEventListener("submit", onSubmit);
})();
