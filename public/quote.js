/**
 * Quote page (Step 1): Same logic as new-form.js, plus Continue button + sessionStorage.
 * Google Places, postcode, pricing, items JSON unchanged.
 */

(function () {
  "use strict";

  const PICKUP = "pickup";
  const DROPOFF = "dropoff";
  const STORAGE_KEY = "collectMyItemQuote";

  const state = { [PICKUP]: null, [DROPOFF]: null };
  let lastQuoteResult = null; // { payload, result } when /api/price succeeds
  let lastItemsSnapshot = null; // JSON stringified items at time of last valid price
  let lastPriceSnapshot = null; // snapshot of all pricing-affecting fields when Get price succeeded
  let hasValidPriceSnapshot = false;

  const el = {
    form: document.getElementById("pricingForm"),
    pickupInput: document.getElementById("pickup"),
    dropoffInput: document.getElementById("dropoff"),
    pickupError: document.getElementById("pickup-error"),
    dropoffError: document.getElementById("dropoff-error"),
    submitBtn: document.getElementById("submitBtn"),
    continueBtn: document.getElementById("continueBtn"),
    resultSection: document.getElementById("resultSection"),
    resultContent: document.getElementById("resultContent"),
    errorSection: document.getElementById("errorSection"),
    errorMessage: document.getElementById("errorMessage"),
    pickupLat: document.getElementById("pickupLat"),
    pickupLng: document.getElementById("pickupLng"),
    pickupPlaceId: document.getElementById("pickupPlaceId"),
    pickupPostcodeHidden: document.getElementById("pickupPostcodeHidden"),
    dropoffLat: document.getElementById("dropoffLat"),
    dropoffLng: document.getElementById("dropoffLng"),
    dropoffPlaceId: document.getElementById("dropoffPlaceId"),
    dropoffPostcodeHidden: document.getElementById("dropoffPostcodeHidden"),
  };

  function showError(field, message) {
    const errEl = field === PICKUP ? el.pickupError : el.dropoffError;
    if (errEl) errEl.textContent = message || "";
  }

  function clearErrors() {
    if (el.pickupError) el.pickupError.textContent = "";
    if (el.dropoffError) el.dropoffError.textContent = "";
    if (el.errorSection) el.errorSection.hidden = true;
  }

  function setLoading(loading) {
    if (el.submitBtn) {
      el.submitBtn.disabled = loading;
      el.submitBtn.textContent = loading ? "Calculating…" : "Get price";
    }
  }

  function setResult(html) {
    if (el.resultSection) el.resultSection.hidden = false;
    if (el.resultContent) el.resultContent.innerHTML = html;
    if (el.errorSection) el.errorSection.hidden = true;
  }

  function setApiError(message) {
    if (el.resultSection) el.resultSection.hidden = true;
    if (el.errorSection) el.errorSection.hidden = false;
    if (el.errorMessage) el.errorMessage.textContent = message || "Something went wrong.";
  }

  function parseJsonResponse(res) {
    return res.text().then(function (text) {
      try {
        return { ok: res.ok, body: text ? JSON.parse(text) : {} };
      } catch (e) {
        if (typeof text === "string" && text.trim().indexOf("<") === 0) {
          throw new Error("The server returned a web page instead of data. Pricing and maps need the backend (Node or PHP) to be running.");
        }
        throw e;
      }
    });
  }

  function getCurrentItemsSnapshot() {
    const itemsListEl = document.getElementById("itemsList");
    if (!itemsListEl || !itemsListEl.value) return "[]";
    return itemsListEl.value;
  }

  function itemsMatchLastSnapshot() {
    if (!lastQuoteResult || !lastItemsSnapshot) return false;
    return getCurrentItemsSnapshot() === lastItemsSnapshot;
  }

  /** Build a snapshot of all fields that affect pricing (for invalidation when they change). */
  function buildSnapshotFromForm() {
    const pickup = state[PICKUP];
    const dropoff = state[DROPOFF];
    const helpersEl = el.form ? el.form.querySelector('[name="helpers"]') : null;
    const helpers = parseInt(helpersEl ? helpersEl.value : "0", 10) || 0;
    const stairsPickup = (el.form ? el.form.querySelector('[name="stairsPickup"]:checked') : null)?.value || "no";
    const stairsDropoff = (el.form ? el.form.querySelector('[name="stairsDropoff"]:checked') : null)?.value || "no";
    const dateEl = el.form ? el.form.querySelector('[name="date"]') : null;
    const timeWindowEl = el.form ? el.form.querySelector('[name="timeWindow"]') : null;
    const date = dateEl ? dateEl.value : "";
    const timeWindow = timeWindowEl ? timeWindowEl.value : "any";
    return {
      pickupAddress: (el.pickupInput ? el.pickupInput.value : "").trim(),
      pickupPostcode: (pickup && pickup.postcode != null) ? String(pickup.postcode).trim() : "",
      pickupLatLng: (pickup && pickup.lat != null && pickup.lng != null) ? String(pickup.lat) + "," + String(pickup.lng) : "",
      dropoffAddress: (el.dropoffInput ? el.dropoffInput.value : "").trim(),
      dropoffPostcode: (dropoff && dropoff.postcode != null) ? String(dropoff.postcode).trim() : "",
      dropoffLatLng: (dropoff && dropoff.lat != null && dropoff.lng != null) ? String(dropoff.lat) + "," + String(dropoff.lng) : "",
      stairsPickup,
      stairsDropoff,
      helpers,
      timeWindow,
      date,
      itemsSummary: getCurrentItemsSnapshot(),
    };
  }

  function snapshotChanged() {
    if (!lastPriceSnapshot) return false;
    const current = buildSnapshotFromForm();
    return (
      current.pickupAddress !== lastPriceSnapshot.pickupAddress ||
      current.pickupPostcode !== lastPriceSnapshot.pickupPostcode ||
      current.pickupLatLng !== lastPriceSnapshot.pickupLatLng ||
      current.dropoffAddress !== lastPriceSnapshot.dropoffAddress ||
      current.dropoffPostcode !== lastPriceSnapshot.dropoffPostcode ||
      current.dropoffLatLng !== lastPriceSnapshot.dropoffLatLng ||
      current.stairsPickup !== lastPriceSnapshot.stairsPickup ||
      current.stairsDropoff !== lastPriceSnapshot.stairsDropoff ||
      current.helpers !== lastPriceSnapshot.helpers ||
      current.timeWindow !== lastPriceSnapshot.timeWindow ||
      current.date !== lastPriceSnapshot.date ||
      current.itemsSummary !== lastPriceSnapshot.itemsSummary
    );
  }

  function checkSnapshotAndInvalidate() {
    if (hasValidPriceSnapshot && snapshotChanged()) {
      hasValidPriceSnapshot = false;
      updateContinueButton();
      if (el.errorSection && el.errorMessage) {
        el.errorSection.hidden = false;
        el.errorMessage.textContent = "Address changed — please Get price again.";
      }
    }
  }

  function updateContinueButton() {
    if (el.continueBtn) {
      const canContinue = !!lastQuoteResult && hasValidPriceSnapshot;
      el.continueBtn.disabled = !canContinue;
      if (!canContinue && lastQuoteResult && !hasValidPriceSnapshot) {
        if (el.errorSection && el.errorMessage) {
          el.errorMessage.textContent = "Address changed — please Get price again.";
          el.errorSection.hidden = false;
        }
      } else if (canContinue && el.errorSection && el.errorMessage) {
        el.errorSection.hidden = true;
        el.errorMessage.textContent = "";
      }
    }
  }

  function fillHiddenFields(which, data) {
    const latEl = which === PICKUP ? el.pickupLat : el.dropoffLat;
    const lngEl = which === PICKUP ? el.pickupLng : el.dropoffLng;
    const placeIdEl = which === PICKUP ? el.pickupPlaceId : el.dropoffPlaceId;
    const postcodeEl = which === PICKUP ? el.pickupPostcodeHidden : el.dropoffPostcodeHidden;
    const v = data || {};
    if (latEl) latEl.value = v.lat != null ? String(v.lat) : "";
    if (lngEl) lngEl.value = v.lng != null ? String(v.lng) : "";
    if (placeIdEl) placeIdEl.value = v.placeId != null ? String(v.placeId) : "";
    if (postcodeEl) postcodeEl.value = v.postcode != null ? String(v.postcode) : "";
  }

  function getPostcodeFromPlace(place) {
    const components = place.address_components || [];
    for (let i = 0; i < components.length; i++) {
      const types = components[i].types || [];
      if (types.indexOf("postal_code") !== -1) {
        return (components[i].long_name || "").trim();
      }
    }
    return "";
  }

  /** Reverse geocode lat/lng to get postcode when address_components did not include it. */
  function reverseGeocodeToPostcode(lat, lng, apiKey) {
    if (!apiKey || lat == null || lng == null) return Promise.resolve("");
    const latlng = encodeURIComponent(lat + "," + lng);
    const url = "https://maps.googleapis.com/maps/api/geocode/json?latlng=" + latlng +
      "&region=gb&key=" + encodeURIComponent(apiKey);
    return fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        const result = data.results && data.results[0];
        if (!result || !result.address_components) return "";
        const components = result.address_components;
        for (let i = 0; i < components.length; i++) {
          if ((components[i].types || []).indexOf("postal_code") !== -1) {
            return (components[i].long_name || "").trim();
          }
        }
        return "";
      })
      .catch(function () { return ""; });
  }

  function onPlaceSelected(which, place) {
    if (!place || !place.geometry || !place.geometry.location) return;
    const lat = place.geometry.location.lat();
    const lng = place.geometry.location.lng();
    const formattedAddress = place.formatted_address || "";
    const placeId = place.place_id || null;
    let postcode = getPostcodeFromPlace(place);
    state[which] = { formattedAddress, postcode: postcode || "", lat, lng, placeId };
    fillHiddenFields(which, state[which]);
    showError(which, "");
    if (!postcode && lat != null && lng != null) {
      const apiKey = window.__quoteApiKey;
      if (apiKey) {
        reverseGeocodeToPostcode(lat, lng, apiKey).then(function (pc) {
          if (pc && state[which] && state[which].lat === lat && state[which].lng === lng) {
            state[which].postcode = pc;
            fillHiddenFields(which, state[which]);
            checkSnapshotAndInvalidate();
            updateContinueButton();
          }
        });
      }
    }
  }

  function geocodeAddress(address, apikey) {
    if (!address || !apikey) return Promise.resolve(null);
    let addr = String(address).trim();
    if (!/,\s*UK$/i.test(addr)) addr = addr + ", UK";
    const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(addr) + "&region=gb&key=" + encodeURIComponent(apikey);
    return fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        const result = data.results && data.results[0];
        if (!result || !result.geometry || !result.geometry.location) return null;
        const components = result.address_components || [];
        let postcode = "";
        for (let i = 0; i < components.length; i++) {
          if ((components[i].types || []).indexOf("postal_code") !== -1) {
            postcode = (components[i].long_name || "").trim();
            break;
          }
        }
        return {
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng,
          postcode: postcode,
          placeId: result.place_id || null,
          formattedAddress: result.formatted_address || addr,
        };
      })
      .catch(function () { return null; });
  }

  function ensureLocationFromInput(which, apiKey) {
    return new Promise(function (resolve) {
      const input = which === PICKUP ? el.pickupInput : el.dropoffInput;
      const raw = input ? input.value.trim() : "";
      if (!raw) {
        state[which] = null;
        fillHiddenFields(which, null);
        resolve(false);
        return;
      }
      if (state[which] && state[which].lat != null && state[which].lng != null) {
        fillHiddenFields(which, state[which]);
        resolve(true);
        return;
      }
      geocodeAddress(raw, apiKey).then(function (result) {
        if (!result) {
          showError(which, "Could not find that address. Please select from the list or try another.");
          resolve(false);
          return;
        }
        state[which] = {
          formattedAddress: result.formattedAddress || raw + ", UK",
          postcode: result.postcode || "",
          lat: result.lat,
          lng: result.lng,
          placeId: result.placeId,
        };
        fillHiddenFields(which, state[which]);
        showError(which, "");
        resolve(true);
      });
    });
  }

  function buildPayload() {
    const pickup = state[PICKUP];
    const dropoff = state[DROPOFF];
    const helpersEl = el.form ? el.form.querySelector('[name="helpers"]') : null;
    const helpers = parseInt(helpersEl ? helpersEl.value : "0", 10) || 0;
    const stairsPickup = (el.form ? el.form.querySelector('[name="stairsPickup"]:checked') : null)?.value || "no";
    const stairsDropoff = (el.form ? el.form.querySelector('[name="stairsDropoff"]:checked') : null)?.value || "no";
    const dateEl = el.form ? el.form.querySelector('[name="date"]') : null;
    const timeWindowEl = el.form ? el.form.querySelector('[name="timeWindow"]') : null;
    const date = dateEl ? dateEl.value : "";
    const timeWindow = timeWindowEl ? timeWindowEl.value : "any";
    const itemsListEl = document.getElementById("itemsList");
    let items = [];
    try {
      if (itemsListEl && itemsListEl.value) items = JSON.parse(itemsListEl.value);
    } catch (_) {}

    return {
      pickup: {
        formattedAddress: pickup.formattedAddress,
        postcode: pickup.postcode,
        lat: pickup.lat,
        lng: pickup.lng,
        placeId: pickup.placeId,
      },
      dropoff: {
        formattedAddress: dropoff.formattedAddress,
        postcode: dropoff.postcode,
        lat: dropoff.lat,
        lng: dropoff.lng,
        placeId: dropoff.placeId,
      },
      items,
      helpers,
      stairsPickup,
      stairsDropoff,
      date,
      timeWindow,
    };
  }

  function renderResult(data) {
    const total = data.total != null ? Number(data.total) : 0;
    const breakdown = data.breakdown || [];
    const note = data.note || "";
    let breakdownHtml = "";
    if (breakdown.length) {
      breakdownHtml = "<ul class=\"result__breakdown\">" +
        breakdown.map(function (line) { return "<li>" + escapeHtml(line) + "</li>"; }).join("") +
        "</ul>";
    }
    const noteHtml = note ? "<p class=\"result__note\">" + escapeHtml(note) + "</p>" : "";
    return "<p class=\"result__total\">Final total price: £" + total.toFixed(2) + "</p>" + breakdownHtml + noteHtml;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function initAutocomplete(inputEl, which, apiKey) {
    if (!window.google || !window.google.maps || !window.google.maps.places) return;
    const options = {
      componentRestrictions: { country: "gb" },
      fields: ["formatted_address", "geometry", "place_id", "address_components"],
    };
    const autocomplete = new window.google.maps.places.Autocomplete(inputEl, options);
    autocomplete.addListener("place_changed", function () {
      const place = autocomplete.getPlace();
      onPlaceSelected(which, place);
    });
  }

  function loadMapsAndInit(apiKey) {
    if (window.__quoteMapsLoaded) {
      initAutocomplete(el.pickupInput, PICKUP, apiKey);
      initAutocomplete(el.dropoffInput, DROPOFF, apiKey);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://maps.googleapis.com/maps/api/js?key=" +
      encodeURIComponent(apiKey) + "&libraries=places&callback=__quoteMapsReady";
    script.async = true;
    script.defer = true;
    window.__quoteMapsReady = function () {
      window.__quoteMapsLoaded = true;
      initAutocomplete(el.pickupInput, PICKUP, apiKey);
      initAutocomplete(el.dropoffInput, DROPOFF, apiKey);
    };
    document.head.appendChild(script);
  }

  function onSubmit(e) {
    e.preventDefault();
    clearErrors();
    lastQuoteResult = null;
    lastItemsSnapshot = null;
    lastPriceSnapshot = null;
    hasValidPriceSnapshot = false;
    updateContinueButton();

    const dateEl = el.form ? el.form.querySelector('[name="date"]') : null;
    const dateValue = dateEl ? dateEl.value : "";
    if (!dateValue) {
      if (dateEl && typeof dateEl.focus === "function") {
        dateEl.focus();
      }
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert("Please choose a preferred collection date before getting a price.");
      }
      if (el.errorSection && el.errorMessage) {
        el.errorSection.hidden = false;
        el.errorMessage.textContent = "Please select a preferred collection date.";
      }
      return;
    }

    const apiKey = window.__quoteApiKey;
    if (!apiKey) {
      setApiError("Google Maps is not configured. Please set GOOGLE_MAPS_API_KEY on the server.");
      return;
    }

    Promise.all([
      ensureLocationFromInput(PICKUP, apiKey),
      ensureLocationFromInput(DROPOFF, apiKey),
    ]).then(function ([pickupOk, dropoffOk]) {
      if (!pickupOk) {
        if (el.pickupInput && !el.pickupInput.value.trim()) showError(PICKUP, "Pickup is required.");
        return;
      }
      if (!dropoffOk) {
        if (el.dropoffInput && !el.dropoffInput.value.trim()) showError(DROPOFF, "Dropoff is required.");
        return;
      }
      if (!state[PICKUP] || state[PICKUP].lat == null || !state[DROPOFF] || state[DROPOFF].lat == null) {
        setApiError("Both pickup and dropoff need a valid location.");
        return;
      }

      const itemsListEl = document.getElementById("itemsList");
      let items = [];
      try {
        if (itemsListEl && itemsListEl.value) items = JSON.parse(itemsListEl.value);
      } catch (_) {}
      if (!items || !items.length) {
        const errEl = document.getElementById("itemsError");
        if (errEl) { errEl.style.display = "block"; errEl.scrollIntoView({ behavior: "smooth", block: "center" }); }
        return;
      }

      const payload = buildPayload();
      setLoading(true);
      fetch("/api/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) { return parseJsonResponse(res).then(function (p) { return { ok: p.ok, body: p.body }; }); })
        .then(function (_ref) {
          setLoading(false);
          if (_ref.ok) {
            lastQuoteResult = { payload, result: _ref.body };
            try {
              lastItemsSnapshot = JSON.stringify(payload.items || []);
            } catch (_) {
              lastItemsSnapshot = getCurrentItemsSnapshot();
            }
            lastPriceSnapshot = buildSnapshotFromForm();
            hasValidPriceSnapshot = true;
            setResult(renderResult(_ref.body));
            if (el.errorSection) el.errorSection.hidden = true;
            if (el.errorMessage) el.errorMessage.textContent = "";
            updateContinueButton();
            if (el.resultSection) el.resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
          } else {
            setApiError(_ref.body.error || "Failed to get price.");
          }
        })
        .catch(function (err) {
          setLoading(false);
          setApiError(err.message || "Network error. Please try again.");
        });
    });
  }

  function onContinue() {
    if (!lastQuoteResult) return;
    const quote = {
      payload: lastQuoteResult.payload,
      result: lastQuoteResult.result,
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(quote));
      window.location.href = "details.html";
    } catch (err) {
      setApiError("Could not save quote. Please try again.");
    }
  }

  if (el.form) {
    el.form.addEventListener("submit", onSubmit);
  }
  if (el.continueBtn) {
    el.continueBtn.addEventListener("click", onContinue);
  }

  window.__quoteOnItemsChanged = function () {
    lastItemsSnapshot = null;
    checkSnapshotAndInvalidate();
    updateContinueButton();
  };

  function addSnapshotChangeListeners() {
    function onSnapshotFieldChange() {
      checkSnapshotAndInvalidate();
    }
    if (el.pickupInput) {
      el.pickupInput.addEventListener("input", onSnapshotFieldChange);
      el.pickupInput.addEventListener("change", onSnapshotFieldChange);
    }
    if (el.dropoffInput) {
      el.dropoffInput.addEventListener("input", onSnapshotFieldChange);
      el.dropoffInput.addEventListener("change", onSnapshotFieldChange);
    }
    const dateEl = el.form ? el.form.querySelector('[name="date"]') : null;
    const timeWindowEl = el.form ? el.form.querySelector('[name="timeWindow"]') : null;
    const helpersEl = el.form ? el.form.querySelector('[name="helpers"]') : null;
    const stairsPickupEls = el.form ? el.form.querySelectorAll('[name="stairsPickup"]') : [];
    const stairsDropoffEls = el.form ? el.form.querySelectorAll('[name="stairsDropoff"]') : [];
    if (dateEl) dateEl.addEventListener("change", onSnapshotFieldChange);
    if (timeWindowEl) timeWindowEl.addEventListener("change", onSnapshotFieldChange);
    if (helpersEl) helpersEl.addEventListener("change", onSnapshotFieldChange);
    stairsPickupEls.forEach(function (radio) {
      radio.addEventListener("change", onSnapshotFieldChange);
    });
    stairsDropoffEls.forEach(function (radio) {
      radio.addEventListener("change", onSnapshotFieldChange);
    });
  }
  addSnapshotChangeListeners();

  fetch("/api/maps-config")
    .then(function (res) { return parseJsonResponse(res).then(function (p) { return { ok: p.ok, data: p.body }; }); })
    .then(function (_ref) {
      var ok = _ref.ok;
      var data = _ref.data;
      if (ok && data && data.apiKey) {
        window.__quoteApiKey = data.apiKey;
        loadMapsAndInit(data.apiKey);
      } else {
        setApiError((data && data.error) || "Could not load map settings. Check that the server is running and GOOGLE_MAPS_API_KEY is set.");
      }
    })
    .catch(function (err) {
      setApiError(err.message || "Could not load map settings. Check that the server is running and GOOGLE_MAPS_API_KEY is set.");
    });
})();

// Items UI (same as new-form.js)
(() => {
  const itemSelect = document.getElementById("itemSelect");
  const addSelectedBtn = document.getElementById("addSelectedItemBtn");
  const customInput = document.getElementById("customItemInput");
  const addCustomBtn = document.getElementById("addCustomItemBtn");
  const itemsListUI = document.getElementById("itemsListUI");
  const itemsHidden = document.getElementById("itemsList");
  const itemsError = document.getElementById("itemsError");

  let items = [];

  function normalizeName(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
  }

  function findIndexByName(name) {
    const n = name.toLowerCase();
    return items.findIndex(i => i.name.toLowerCase() === n);
  }

  function syncHidden() {
    if (itemsHidden) itemsHidden.value = JSON.stringify(items);
  }

  function render() {
    if (!itemsListUI) return;
    itemsListUI.innerHTML = "";
    items.forEach((item, idx) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "10px";
      row.style.alignItems = "center";
      row.style.flexWrap = "wrap";

      const label = document.createElement("div");
      label.textContent = item.name;
      label.style.minWidth = "240px";

      const qty = document.createElement("input");
      qty.type = "number";
      qty.min = "1";
      qty.step = "1";
      qty.value = String(item.qty || 1);
      qty.style.width = "90px";
      qty.addEventListener("input", () => {
        const v = parseInt(qty.value, 10);
        items[idx].qty = Number.isFinite(v) && v > 0 ? v : 1;
        syncHidden();
        if (typeof window !== "undefined" && typeof window.__quoteOnItemsChanged === "function") {
          window.__quoteOnItemsChanged();
        }
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        items.splice(idx, 1);
        syncHidden();
        render();
        if (typeof window !== "undefined" && typeof window.__quoteOnItemsChanged === "function") {
          window.__quoteOnItemsChanged();
        }
      });

      row.appendChild(label);
      row.appendChild(qty);
      row.appendChild(removeBtn);
      itemsListUI.appendChild(row);
    });
    syncHidden();
  }

  function addItem(name, isCustom) {
    const clean = normalizeName(name);
    if (!clean) return;
    const existingIdx = findIndexByName(clean);
    if (existingIdx >= 0) {
      items[existingIdx].qty = (items[existingIdx].qty || 1) + 1;
      if (isCustom) {
        items[existingIdx].isCustom = true;
      }
    } else {
      items.push({ name: clean, qty: 1, isCustom: !!isCustom });
    }
    if (itemsError) itemsError.style.display = "none";
    render();
    if (typeof window !== "undefined" && typeof window.__quoteOnItemsChanged === "function") {
      window.__quoteOnItemsChanged();
    }
  }

  addSelectedBtn?.addEventListener("click", () => {
    addItem(itemSelect.value, false);
    if (itemSelect) itemSelect.selectedIndex = 0;
  });

  addCustomBtn?.addEventListener("click", () => {
    addItem(customInput.value, true);
    if (customInput) { customInput.value = ""; customInput.focus(); }
  });

  customInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustomBtn?.click(); }
  });

  render();
})();
