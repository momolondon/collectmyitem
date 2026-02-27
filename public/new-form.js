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
    const serviceType = (el.form.querySelector('[name="serviceType"]') || {}).value || "standard";
    const itemsCount = parseInt(
      (el.form.querySelector('[name="itemsCount"]') || {}).value,
      10
    ) || 1;
    const stairsPickup = (el.form.querySelector('[name="stairsPickup"]:checked') || {}).value || "no";
    const stairsDropoff = (el.form.querySelector('[name="stairsDropoff"]:checked') || {}).value || "no";
    const date = (el.form.querySelector('[name="date"]') || {}).value || "";
    const timeWindow = (el.form.querySelector('[name="timeWindow"]') || {}).value || "any";

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
      serviceType,
      itemsCount,
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
          return res.json().then(function (body) {
            return { ok: res.ok, status: res.status, body };
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
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.apiKey) {
        window.__newFormApiKey = data.apiKey;
        loadMapsAndInit(data.apiKey);
      }
    })
    .catch(function () {
      setApiError("Could not load map settings. Check that the server is running and GOOGLE_MAPS_API_KEY is set.");
    });
})();
