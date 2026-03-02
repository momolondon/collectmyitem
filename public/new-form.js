/**
 * New pricing form: UK Places Autocomplete, postcode fallback, POST /api/price
 */

(function () {
  "use strict";

  const PICKUP = "pickup";
  const DROPOFF = "dropoff";

  // State for each location: { formattedAddress, postcode, lat, lng, placeId }
  const state = {
    [PICKUP]: null,
    [DROPOFF]: null,
  };

  const el = {
    form: document.getElementById("pricingForm"),
    pickupInput: document.getElementById("pickup"),
    dropoffInput: document.getElementById("dropoff"),
    pickupError: document.getElementById("pickup-error"),
    dropoffError: document.getElementById("dropoff-error"),
    submitBtn: document.getElementById("submitBtn"),
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

  // UK postcode: outward (1–2 letters + digit + optional letter/digit) + inward (digit + 2 letters)
  function cleanPostcode(str) {
    return String(str || "").trim().toUpperCase().replace(/\s+/g, "");
  }

  function isValidUKPostcode(str) {
    const s = cleanPostcode(str);
    return /^[A-Z]{1,2}\d[A-Z0-9]?\d[A-Z]{2}$/.test(s);
  }

  function formatPostcodeForDisplay(pc) {
    const s = cleanPostcode(pc);
    if (s.length >= 5 && s.charAt(s.length - 4) !== " ") {
      return s.slice(0, -3) + " " + s.slice(-3);
    }
    return s;
  }

  function showError(field, message) {
    const errEl = field === PICKUP ? el.pickupError : el.dropoffError;
    errEl.textContent = message || "";
  }

  function clearErrors() {
    el.pickupError.textContent = "";
    el.dropoffError.textContent = "";
    el.errorSection.hidden = true;
  }

  function setLoading(loading) {
    el.submitBtn.disabled = loading;
    el.submitBtn.textContent = loading ? "Calculating…" : "Get instant price";
  }

  function setResult(html) {
    el.resultSection.hidden = false;
    el.resultContent.innerHTML = html;
    el.errorSection.hidden = true;
  }

  function setApiError(message) {
    el.resultSection.hidden = true;
    el.errorSection.hidden = false;
    el.errorMessage.textContent = message || "Something went wrong.";
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

  /** Fill hidden inputs for a location from state/geocode result */
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

  /** Extract postcode from Google place address_components */
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

  /** When user selects an autocomplete suggestion */
  function onPlaceSelected(which, place) {
    if (!place || !place.geometry || !place.geometry.location) return;
    const lat = place.geometry.location.lat();
    const lng = place.geometry.location.lng();
    const formattedAddress = place.formatted_address || "";
    const postcode = getPostcodeFromPlace(place);
    const placeId = place.place_id || null;
    state[which] = {
      formattedAddress,
      postcode: postcode || "",
      lat,
      lng,
      placeId,
    };
    fillHiddenFields(which, state[which]);
    showError(which, "");
  }

  /** Geocode a UK postcode string and return { lat, lng } or null */
  function geocodePostcode(postcode, apiKey) {
    const formatted = formatPostcodeForDisplay(postcode) + ", UK";
    const url =
      "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(formatted) +
      "&region=gb&key=" +
      encodeURIComponent(apiKey);

    return fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        const result = data.results && data.results[0];
        if (!result || !result.geometry || !result.geometry.location) return null;
        return {
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng,
        };
      })
      .catch(function () { return null; });
  }

  /** Geocode an address string via Google Geocoding API.
   * Adds ", UK" automatically if missing. Extracts postcode from address_components.
   * Returns { lat, lng, postcode, placeId } or null. */
  function geocodeAddress(address, apikey) {
    if (!address || !apikey) return Promise.resolve(null);
    let addr = String(address).trim();
    if (!/,\s*UK$/i.test(addr)) {
      addr = addr + ", UK";
    }
    const url =
      "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(addr) +
      "&region=gb&key=" +
      encodeURIComponent(apikey);

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

  /** If place/lat/lng missing, call geocodeAddress with input value and fill hidden fields */
  function ensureLocationFromInput(which, apiKey) {
    return new Promise(function (resolve) {
      const input = which === PICKUP ? el.pickupInput : el.dropoffInput;
      const raw = input.value.trim();
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
    const helpersEl = el.form.querySelector('[name="helpers"]');
    const helpers = parseInt(helpersEl ? helpersEl.value : "0", 10) || 0;
    const stairsPickup = (el.form.querySelector('[name="stairsPickup"]:checked') || {}).value || "no";
    const stairsDropoff = (el.form.querySelector('[name="stairsDropoff"]:checked') || {}).value || "no";
    const date = (el.form.querySelector('[name="date"]') || {}).value || "";
    const timeWindow = (el.form.querySelector('[name="timeWindow"]') || {}).value || "any";
    const itemsListEl = document.getElementById("itemsList");
    let items = [];
    try {
      if (itemsListEl && itemsListEl.value) {
        items = JSON.parse(itemsListEl.value);
      }
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
      breakdownHtml =
        "<ul class=\"result__breakdown\">" +
        breakdown.map(function (line) { return "<li>" + escapeHtml(line) + "</li>"; }).join("") +
        "</ul>";
    }
    var noteHtml = note ? "<p class=\"result__note\">" + escapeHtml(note) + "</p>" : "";
    return (
      "<p class=\"result__total\">Final total price: £" + total.toFixed(2) + "</p>" +
      breakdownHtml +
      noteHtml
    );
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
    if (window.__newFormMapsLoaded) {
      initAutocomplete(el.pickupInput, PICKUP, apiKey);
      initAutocomplete(el.dropoffInput, DROPOFF, apiKey);
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js?key=" +
      encodeURIComponent(apiKey) +
      "&libraries=places&callback=__newFormMapsReady";
    script.async = true;
    script.defer = true;
    window.__newFormMapsReady = function () {
      window.__newFormMapsLoaded = true;
      initAutocomplete(el.pickupInput, PICKUP, apiKey);
      initAutocomplete(el.dropoffInput, DROPOFF, apiKey);
    };
    document.head.appendChild(script);
  }

  function onSubmit(e) {
    e.preventDefault();
    clearErrors();
    const apiKey = window.__newFormApiKey;
    if (!apiKey) {
      setApiError("Google Maps is not configured. Please set GOOGLE_MAPS_API_KEY on the server.");
      return;
    }

    // Ensure both locations have lat/lng (from autocomplete or postcode geocode)
    Promise.all([
      ensureLocationFromInput(PICKUP, apiKey),
      ensureLocationFromInput(DROPOFF, apiKey),
    ]).then(function ([pickupOk, dropoffOk]) {
      if (!pickupOk) {
        if (!el.pickupInput.value.trim()) el.pickupError.textContent = "Pickup is required.";
        return;
      }
      if (!dropoffOk) {
        if (!el.dropoffInput.value.trim()) el.dropoffError.textContent = "Dropoff is required.";
        return;
      }
      if (
        !state[PICKUP] || state[PICKUP].lat == null ||
        !state[DROPOFF] || state[DROPOFF].lat == null
      ) {
        setApiError("Both pickup and dropoff need a valid location.");
        return;
      }

      const payload = buildPayload();
      setLoading(true);
      fetch("/api/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return parseJsonResponse(res).then(function (p) {
            return { ok: res.ok, status: res.status, body: p.body };
          });
        })
        .then(function (_ref) {
          var ok = _ref.ok;
          var body = _ref.body;
          setLoading(false);
          if (ok) {
            setResult(renderResult(body));
            el.resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
          } else {
            setApiError(body.error || "Failed to get price.");
          }
        })
        .catch(function (err) {
          setLoading(false);
          setApiError(err.message || "Network error. Please try again.");
        });
    });
  }

  if (el.form) {
    el.form.addEventListener("submit", onSubmit);
  }

  // Fetch Maps API key and init
  fetch("/api/maps-config")
    .then(function (res) { return parseJsonResponse(res).then(function (p) { return p.body; }); })
    .then(function (data) {
      if (data && data.apiKey) {
        window.__newFormApiKey = data.apiKey;
        loadMapsAndInit(data.apiKey);
      }
    })
    .catch(function (err) {
      setApiError(err.message || "Could not load map settings. Check that the server is running and GOOGLE_MAPS_API_KEY is set.");
    });
})();
(() => {
  const itemSelect = document.getElementById("itemSelect");
  const addSelectedBtn = document.getElementById("addSelectedItemBtn");
  const customInput = document.getElementById("customItemInput");
  const addCustomBtn = document.getElementById("addCustomItemBtn");
  const itemsListUI = document.getElementById("itemsListUI");
  const itemsHidden = document.getElementById("itemsList");
  const itemsError = document.getElementById("itemsError");

  // Internal state: [{ name: "Sofa", qty: 1 }]
  let items = [];

  function normalizeName(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
  }

  function findIndexByName(name) {
    const n = name.toLowerCase();
    return items.findIndex(i => i.name.toLowerCase() === n);
  }

  function syncHidden() {
    itemsHidden.value = JSON.stringify(items);
  }

  function render() {
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
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        items.splice(idx, 1);
        syncHidden();
        render();
      });

      row.appendChild(label);
      row.appendChild(qty);
      row.appendChild(removeBtn);

      itemsListUI.appendChild(row);
    });

    syncHidden();
  }

  function addItem(name) {
    const clean = normalizeName(name);
    if (!clean) return;

    const existingIdx = findIndexByName(clean);
    if (existingIdx >= 0) {
      // If already exists, just increment qty
      items[existingIdx].qty = (items[existingIdx].qty || 1) + 1;
    } else {
      items.push({ name: clean, qty: 1 });
    }
    itemsError.style.display = "none";
    render();
  }

  addSelectedBtn?.addEventListener("click", () => {
    addItem(itemSelect.value);
    // Optional: reset select
    itemSelect.selectedIndex = 0;
  });

  addCustomBtn?.addEventListener("click", () => {
    addItem(customInput.value);
    customInput.value = "";
    customInput.focus();
  });

  customInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomBtn.click();
    }
  });

  // OPTIONAL: If you want "required" behaviour on submit
  const form = itemsHidden.closest("form");
  form?.addEventListener("submit", (e) => {
    if (!items.length) {
      e.preventDefault();
      itemsError.style.display = "block";
      itemsError.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  // Init
  render();
})();
