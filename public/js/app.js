const $ = (id) => document.getElementById(id);

const yearEl = $("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

const quoteForm = $("quoteForm");
const bookingForm = $("bookingForm");
const confirmBox = $("confirmBox");

const btnGetPrice = $("btnGetPrice");
const btnBook = $("btnBook");
const btnBack = $("btnBack");
const btnNewQuote = $("btnNewQuote");

const pickupAutocomplete = document.getElementById("pickupAutocomplete");
const dropoffAutocomplete = document.getElementById("dropoffAutocomplete");

// Visible address inputs (classic Places Autocomplete)
const pickupAddressInput = document.getElementById("pickupAddress");
const dropoffAddressInput = document.getElementById("dropoffAddress");

// Hidden postcode fields (legacy + new naming)
const pickupPostcodeHidden = document.getElementById("pickupPostcode");
const dropoffPostcodeHidden = document.getElementById("dropoffPostcode");
const pickupPostcodeAltHidden = document.getElementById("pickup_postcode");
const dropoffPostcodeAltHidden = document.getElementById("dropoff_postcode");

// Hidden fields to store full Google Places details
const pickupFullAddressHidden = document.getElementById("pickup_full_address");
const pickupPlaceIdHidden = document.getElementById("pickup_place_id");
const pickupLatHidden = document.getElementById("pickup_lat");
const pickupLngHidden = document.getElementById("pickup_lng");

const dropoffFullAddressHidden = document.getElementById("dropoff_full_address");
const dropoffPlaceIdHidden = document.getElementById("dropoff_place_id");
const dropoffLatHidden = document.getElementById("dropoff_lat");
const dropoffLngHidden = document.getElementById("dropoff_lng");

const priceBox = $("priceBox");
const priceValue = $("priceValue"); // deposit today
const zoneBadge = $("zoneBadge");
const priceBreakdown = $("priceBreakdown");
const priceNote = $("priceNote");

let lastQuote = null;

const currentPage = document.body?.dataset?.page || "";

// Track whether a valid Places result has been selected
let pickupAddressSelected = false;
let dropoffAddressSelected = false;

// ==========================
// GENERIC UI / FETCH HELPERS
// ==========================

function scrollToEl(el) {
  if (!el || typeof el.scrollIntoView !== "function") return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function smoothReveal(el) {
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "translateY(8px)";
  el.hidden = false;
  requestAnimationFrame(() => {
    el.style.transition = "opacity 150ms ease-out, transform 150ms ease-out";
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });
}

function smoothHide(el) {
  if (!el) return;
  el.style.transition = "opacity 120ms ease-out, transform 120ms ease-out";
  el.style.opacity = "0";
  el.style.transform = "translateY(-4px)";
  setTimeout(() => {
    el.hidden = true;
  }, 140);
}

async function postJSON(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} failed (${res.status}): ${text}`);
  }

  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : {};
}

// ==========================
// ADDRESS AUTOCOMPLETE (NEW GOOGLE PLACES)
// ==========================

function clearPickupLocationFields() {
  if (pickupFullAddressHidden) pickupFullAddressHidden.value = "";
  if (pickupPlaceIdHidden) pickupPlaceIdHidden.value = "";
  if (pickupLatHidden) pickupLatHidden.value = "";
  if (pickupLngHidden) pickupLngHidden.value = "";
  if (pickupPostcodeHidden) pickupPostcodeHidden.value = "";
  if (pickupPostcodeAltHidden) pickupPostcodeAltHidden.value = "";
}

function clearDropoffLocationFields() {
  if (dropoffFullAddressHidden) dropoffFullAddressHidden.value = "";
  if (dropoffPlaceIdHidden) dropoffPlaceIdHidden.value = "";
  if (dropoffLatHidden) dropoffLatHidden.value = "";
  if (dropoffLngHidden) dropoffLngHidden.value = "";
  if (dropoffPostcodeHidden) dropoffPostcodeHidden.value = "";
  if (dropoffPostcodeAltHidden) dropoffPostcodeAltHidden.value = "";
}

function readLatLngNumber(latLngLike, key) {
  if (!latLngLike) return null;
  const v = latLngLike[key];
  if (typeof v === "function") return v.call(latLngLike);
  if (typeof v === "number") return v;
  return null;
}

function extractPostcodeFromAddressComponents(addressComponents) {
  const list = Array.isArray(addressComponents) ? addressComponents : [];
  for (const c of list) {
    const types = c?.types;
    if (Array.isArray(types) && types.includes("postal_code")) {
      return c.longText || c.shortText || "";
    }
  }
  return "";
}

function setAutocompleteValue(el, value) {
  if (!el) return;
  try {
    if (typeof el.value !== "undefined") el.value = value;
  } catch {
    // ignore
  }
}

function syncFreeTextToPostcode(el, postcodeHidden, clearLocationFields) {
  if (!el || !postcodeHidden) return;

  const handler = () => {
    const val = (el.value ?? "").toString();
    postcodeHidden.value = val || "";
    clearLocationFields();
  };

  el.addEventListener("input", handler);
  el.addEventListener("change", handler);

  // Some browsers/components don't bubble `input` reliably from the internal input.
  // Bind to the internal input when it becomes available.
  let tries = 0;
  const maxTries = 25;
  const timer = setInterval(() => {
    tries += 1;
    if (tries > maxTries) {
      clearInterval(timer);
      return;
    }
    const root = el.shadowRoot;
    const inner = root?.querySelector?.("input");
    if (!inner) return;
    inner.addEventListener("input", handler);
    inner.addEventListener("change", handler);
    clearInterval(timer);
  }, 200);
}

async function initPlacesAutocompleteElements() {
  if (!pickupAutocomplete && !dropoffAutocomplete) return;

  // Wait for the Google Maps script (async) to define the custom element.
  try {
    await customElements.whenDefined("gmp-place-autocomplete");
  } catch {
    // ignore
  }

  // When user types manually (no selection yet), keep postcode fields in sync
  syncFreeTextToPostcode(pickupAutocomplete, pickupPostcodeHidden, clearPickupLocationFields);
  syncFreeTextToPostcode(dropoffAutocomplete, dropoffPostcodeHidden, clearDropoffLocationFields);

  pickupAutocomplete?.addEventListener("gmp-select", async ({ placePrediction }) => {
    try {
      if (!placePrediction) return;

      const place = placePrediction.toPlace();
      await place.fetchFields({ fields: ["formattedAddress", "location", "addressComponents"] });

      const formatted = place.formattedAddress || "";
      if (pickupFullAddressHidden) pickupFullAddressHidden.value = formatted;
      if (pickupPlaceIdHidden) pickupPlaceIdHidden.value = place.id || placePrediction.placeId || "";
      setAutocompleteValue(pickupAutocomplete, formatted);

      const loc = place.location;
      const lat = readLatLngNumber(loc, "lat");
      const lng = readLatLngNumber(loc, "lng");
      if (pickupLatHidden) pickupLatHidden.value = lat != null ? String(lat) : "";
      if (pickupLngHidden) pickupLngHidden.value = lng != null ? String(lng) : "";

      const postcode = extractPostcodeFromAddressComponents(place.addressComponents);
      if (pickupPostcodeHidden) pickupPostcodeHidden.value = postcode || "";

      if (!postcode) {
        alert("We couldn't find a postcode for this address. Please type the postcode manually.");
      }
    } catch (err) {
      console.error(err);
      alert("Please select a valid UK address from the suggestions.");
      clearPickupLocationFields();
    }
  });

  dropoffAutocomplete?.addEventListener("gmp-select", async ({ placePrediction }) => {
    try {
      if (!placePrediction) return;

      const place = placePrediction.toPlace();
      await place.fetchFields({ fields: ["formattedAddress", "location", "addressComponents"] });

      const formatted = place.formattedAddress || "";
      if (dropoffFullAddressHidden) dropoffFullAddressHidden.value = formatted;
      if (dropoffPlaceIdHidden) dropoffPlaceIdHidden.value = place.id || placePrediction.placeId || "";
      setAutocompleteValue(dropoffAutocomplete, formatted);

      const loc = place.location;
      const lat = readLatLngNumber(loc, "lat");
      const lng = readLatLngNumber(loc, "lng");
      if (dropoffLatHidden) dropoffLatHidden.value = lat != null ? String(lat) : "";
      if (dropoffLngHidden) dropoffLngHidden.value = lng != null ? String(lng) : "";

      const postcode = extractPostcodeFromAddressComponents(place.addressComponents);
      if (dropoffPostcodeHidden) dropoffPostcodeHidden.value = postcode || "";

      if (!postcode) {
        alert("We couldn't find a postcode for this address. Please type the postcode manually.");
      }
    } catch (err) {
      console.error(err);
      alert("Please select a valid UK address from the suggestions.");
      clearDropoffLocationFields();
    }
  });
}

initPlacesAutocompleteElements();

// ==========================
// CLASSIC GOOGLE PLACES AUTOCOMPLETE (text inputs)
// ==========================
//
function handlePlaceChangedClassic(autocomplete, kind) {
  const place = autocomplete.getPlace();
  if (!place) return;

  const formatted = place.formatted_address || "";
  const loc = place.geometry?.location || null;
  const lat = loc ? readLatLngNumber(loc, "lat") : null;
  const lng = loc ? readLatLngNumber(loc, "lng") : null;
  const postcode = extractPostcodeFromAddressComponents(place.address_components);

  if (kind === "pickup") {
    if (pickupFullAddressHidden) pickupFullAddressHidden.value = formatted;
    if (pickupLatHidden) pickupLatHidden.value = lat != null ? String(lat) : "";
    if (pickupLngHidden) pickupLngHidden.value = lng != null ? String(lng) : "";
    if (pickupPostcodeHidden) pickupPostcodeHidden.value = postcode || "";
    if (pickupPostcodeAltHidden) pickupPostcodeAltHidden.value = postcode || "";
    if (pickupAddressInput) pickupAddressInput.value = formatted;
    pickupAddressSelected = true;
  } else if (kind === "dropoff") {
    if (dropoffFullAddressHidden) dropoffFullAddressHidden.value = formatted;
    if (dropoffLatHidden) dropoffLatHidden.value = lat != null ? String(lat) : "";
    if (dropoffLngHidden) dropoffLngHidden.value = lng != null ? String(lng) : "";
    if (dropoffPostcodeHidden) dropoffPostcodeHidden.value = postcode || "";
    if (dropoffPostcodeAltHidden) dropoffPostcodeAltHidden.value = postcode || "";
    if (dropoffAddressInput) dropoffAddressInput.value = formatted;
    dropoffAddressSelected = true;
  }

  if (!postcode) {
    alert("Please select a valid UK address from the dropdown.");
  }
}

function attachManualInputHandlers(inputEl, clearFn, setSelectedFlag, postcodeHidden, postcodeAltHidden) {
  if (!inputEl) return;
  const handler = () => {
    const raw = (inputEl.value || "").toString();
    // Clear location-specific fields (lat/lng/place details)
    clearFn();
    // We still want pricing & validation to work off the hidden postcode fields
    if (postcodeHidden) postcodeHidden.value = raw;
    if (postcodeAltHidden) postcodeAltHidden.value = raw;
    setSelectedFlag(false);
  };
  inputEl.addEventListener("input", handler);
  inputEl.addEventListener("change", handler);
}

function initPlacesClassic() {
  if (!pickupAddressInput && !dropoffAddressInput) return;

  const tryInit = () => {
    const gm = window.google?.maps;
    if (!gm || !gm.places || !gm.places.Autocomplete) return false;

    const options = {
      componentRestrictions: { country: "gb" },
      fields: ["address_components", "formatted_address", "geometry"],
      types: ["address"],
    };

    if (pickupAddressInput) {
      const acPickup = new gm.places.Autocomplete(pickupAddressInput, options);
      acPickup.addListener("place_changed", () => handlePlaceChangedClassic(acPickup, "pickup"));
    }

    if (dropoffAddressInput) {
      const acDropoff = new gm.places.Autocomplete(dropoffAddressInput, options);
      acDropoff.addListener("place_changed", () => handlePlaceChangedClassic(acDropoff, "dropoff"));
    }

    attachManualInputHandlers(
      pickupAddressInput,
      clearPickupLocationFields,
      (v) => {
        pickupAddressSelected = v;
      },
      pickupPostcodeHidden,
      pickupPostcodeAltHidden
    );
    attachManualInputHandlers(
      dropoffAddressInput,
      clearDropoffLocationFields,
      (v) => {
        dropoffAddressSelected = v;
      },
      dropoffPostcodeHidden,
      dropoffPostcodeAltHidden
    );

    return true;
  };

  if (tryInit()) return;

  let attempts = 0;
  const maxAttempts = 40;
  const timer = setInterval(() => {
    attempts += 1;
    if (tryInit() || attempts >= maxAttempts) {
      clearInterval(timer);
    }
  }, 300);
}

document.addEventListener("DOMContentLoaded", initPlacesClassic);

document.addEventListener("DOMContentLoaded", () => {
  if (currentPage !== "step2") return;

  try {
    const pickupAddressStored = sessionStorage.getItem("pickupAddress") || "";
    const dropoffAddressStored = sessionStorage.getItem("dropoffAddress") || "";
    const pickupPostcodeStored = sessionStorage.getItem("pickupPostcode") || "";
    const dropoffPostcodeStored = sessionStorage.getItem("dropoffPostcode") || "";

    const pickupDisplay = document.getElementById("pickupAddressReadOnly");
    const dropoffDisplay = document.getElementById("dropoffAddressReadOnly");

    if (pickupDisplay) pickupDisplay.value = pickupAddressStored || pickupPostcodeStored;
    if (dropoffDisplay) dropoffDisplay.value = dropoffAddressStored || dropoffPostcodeStored;

    if (pickupPostcodeHidden) pickupPostcodeHidden.value = pickupPostcodeStored;
    if (pickupPostcodeAltHidden) pickupPostcodeAltHidden.value = pickupPostcodeStored;
    if (dropoffPostcodeHidden) dropoffPostcodeHidden.value = dropoffPostcodeStored;
    if (dropoffPostcodeAltHidden) dropoffPostcodeAltHidden.value = dropoffPostcodeStored;

    if (pickupFullAddressHidden) {
      pickupFullAddressHidden.value = pickupAddressStored || pickupPostcodeStored;
    }
    if (dropoffFullAddressHidden) {
      dropoffFullAddressHidden.value = dropoffAddressStored || dropoffPostcodeStored;
    }
  } catch (err) {
    console.warn("Unable to read sessionStorage on details page", err);
  }
});

// ==========================
// HELPERS
// ==========================

function cleanPostcode(pc) {
  return String(pc || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isLikelyValidPostcode(pc) {
  const s = cleanPostcode(pc);
  // Simple UK postcode check (basic, not exhaustive)
  return /^[A-Z]{1,2}\d[A-Z0-9]?\d[A-Z]{2}$/.test(s);
}

function isWithinServiceArea(pc) {
  const s = cleanPostcode(pc);
  const match = s.match(/^[A-Z]+/);
  if (!match) return false;
  const area = match[0];

  // London, Kent, Essex postal areas
  const allowedAreas = new Set([
    // London core + outer
    "E",
    "EC",
    "N",
    "NW",
    "SE",
    "SW",
    "W",
    "WC",
    "BR",
    "CR",
    "EN",
    "HA",
    "IG",
    "KT",
    "RM",
    "SM",
    "TW",
    "UB",
    // Kent
    "CT",
    "DA",
    "ME",
    "TN",
    // Essex
    "CM",
    "CO",
    "SS",
  ]);

  return allowedAreas.has(area);
}

// ==========================
// SHOW PRICE (TOTAL / DEPOSIT / REMAINING)
// ==========================

function showPriceUI(result) {
  if (!priceBox || !priceValue || !zoneBadge || !priceBreakdown || !priceNote) {
    console.error("Missing price UI elements:", {
      priceBox,
      priceValue,
      zoneBadge,
      priceBreakdown,
      priceNote,
    });
    alert(
      "Price UI error: missing elements in HTML (IDs). Check priceBox/priceValue/zoneBadge/priceBreakdown/priceNote."
    );
    return;
  }

  const priceTotal = document.getElementById("priceTotal");
  const priceRemaining = document.getElementById("priceRemaining");

  const total = Number(result.total ?? 0);
  const deposit = Number(result.deposit ?? 0);
  const remaining = Number(result.remaining ?? 0);

  priceValue.textContent = `£${deposit.toFixed(0)}`;
  if (priceTotal) priceTotal.textContent = `£${total.toFixed(0)}`;
  if (priceRemaining) priceRemaining.textContent = `£${remaining.toFixed(0)}`;

  zoneBadge.textContent =
    result.serviceLabel ||
    (result.serviceType === "house_removal" ? "House Removal" : "Man & Van");

  priceBreakdown.innerHTML = (result.breakdown || [])
    .map((line) => `<div>• ${line}</div>`)
    .join("");

  priceNote.textContent =
    result.note ||
    "You pay only the deposit now. Remaining balance is paid on the day.";

  priceBox.hidden = false;
  smoothReveal(priceBox);

  if (btnBook) btnBook.disabled = false;
  setTimeout(() => scrollToEl(priceBox), 150);
}

// ==========================
// GET FORM DATA
// ==========================

function getQuotePayload() {
  const fd = new FormData(quoteForm);

  return {
    pickup: cleanPostcode(fd.get("pickup")),
    dropoff: cleanPostcode(fd.get("dropoff")),
    serviceType: fd.get("serviceType"),
    houseSize: fd.get("houseSize") || "",
    itemCount: fd.get("itemCount") || "",
    itemDetails: fd.get("itemDetails") || "",
    stairsPickup: fd.get("stairsPickup") || "no",
    stairsDropoff: fd.get("stairsDropoff") || "no",
    date: fd.get("date") || "",
    timeWindow: fd.get("timeWindow") || "any",
    pickupFullAddress: fd.get("pickup_full_address") || "",
    dropoffFullAddress: fd.get("dropoff_full_address") || "",
    pickupPlaceId: fd.get("pickup_place_id") || "",
    dropoffPlaceId: fd.get("dropoff_place_id") || "",
    pickupLat: fd.get("pickup_lat") || "",
    pickupLng: fd.get("pickup_lng") || "",
    dropoffLat: fd.get("dropoff_lat") || "",
    dropoffLng: fd.get("dropoff_lng") || "",
  };
}

function buildValidatedQuotePayload() {
  if (!quoteForm || !quoteForm.reportValidity()) return null;

  const payload = getQuotePayload();

  if (!payload.pickup || !payload.dropoff) {
    alert("Please enter valid UK pickup and delivery postcodes.");
    return null;
  }

  if (!isLikelyValidPostcode(payload.pickup) || !isLikelyValidPostcode(payload.dropoff)) {
    alert("Please enter valid UK postcodes for pickup and delivery.");
    return null;
  }

  if (!isWithinServiceArea(payload.pickup) || !isWithinServiceArea(payload.dropoff)) {
    alert("Sorry, we currently only cover London, Kent and Essex.");
    return null;
  }

  if (payload.serviceType === "house_removal" && !payload.houseSize) {
    alert("Please select the property size for house removal.");
    return null;
  }

  return payload;
}

// ==========================
// SERVICE TYPE TOGGLING
// ==========================

const serviceTypeSelect = document.getElementById("serviceType");
const houseSizeWrapper = document.getElementById("houseSizeWrapper");
const manVanDetailsRow = document.getElementById("manVanDetailsRow");

serviceTypeSelect?.addEventListener("change", () => {
  const value = serviceTypeSelect.value;
  if (value === "house_removal") {
    if (houseSizeWrapper) houseSizeWrapper.hidden = false;
    if (manVanDetailsRow) manVanDetailsRow.style.display = "none";
  } else {
    if (houseSizeWrapper) houseSizeWrapper.hidden = true;
    if (manVanDetailsRow) manVanDetailsRow.style.display = "";
  }
});

// ==========================
// GET PRICE BUTTON
// ==========================

btnGetPrice?.addEventListener("click", async () => {
  if (currentPage === "step1") {
    const payloadStep1 = buildValidatedQuotePayload();
    if (!payloadStep1) return;

    const pickupAddressStep1 =
      pickupAddressInput?.value ||
      pickupFullAddressHidden?.value ||
      payloadStep1.pickup ||
      "";
    const dropoffAddressStep1 =
      dropoffAddressInput?.value ||
      dropoffFullAddressHidden?.value ||
      payloadStep1.dropoff ||
      "";

    try {
      sessionStorage.setItem("pickupPostcode", payloadStep1.pickup);
      sessionStorage.setItem("dropoffPostcode", payloadStep1.dropoff);
      sessionStorage.setItem("pickupAddress", pickupAddressStep1);
      sessionStorage.setItem("dropoffAddress", dropoffAddressStep1);
    } catch (err) {
      console.warn("Unable to persist to sessionStorage", err);
    }

    window.location.href = "details.html";
    return;
  }

  if (!quoteForm.reportValidity()) return;

  const payload = getQuotePayload();

  if (!payload.pickup || !payload.dropoff) {
    alert("Please enter valid UK pickup and delivery postcodes.");
    return;
  }

  if (!isLikelyValidPostcode(payload.pickup) || !isLikelyValidPostcode(payload.dropoff)) {
    alert("Please enter valid UK postcodes for pickup and delivery.");
    return;
  }

  if (!isWithinServiceArea(payload.pickup) || !isWithinServiceArea(payload.dropoff)) {
    alert("Sorry, we currently only cover London, Kent and Essex.");
    return;
  }

  if (payload.serviceType === "house_removal" && !payload.houseSize) {
    alert("Please select the property size for house removal.");
    return;
  }

  if (btnBook) btnBook.disabled = true;
  if (priceBox && !priceBox.hidden) smoothHide(priceBox);

  btnGetPrice.disabled = true;
  btnGetPrice.textContent = "Calculating…";

  try {
    const result = await postJSON("/api/price", payload);
    if (
      !result ||
      typeof result.total !== "number" ||
      typeof result.deposit !== "number" ||
      typeof result.remaining !== "number"
    ) {
      throw new Error("Bad /api/price response");
    }

    lastQuote = { payload, result };
    showPriceUI(result);
  } catch (err) {
    alert("Sorry — we couldn’t calculate the price. Please try again.");
    console.error(err);
  } finally {
    btnGetPrice.disabled = false;
    btnGetPrice.textContent = "Get instant price";
  }
});

// ==========================
// SHOW BOOKING FORM
// ==========================

btnBook?.addEventListener("click", () => {
  if (!lastQuote) return;
  quoteForm.hidden = true;
  bookingForm.hidden = false;
});

// ==========================
// BACK BUTTON
// ==========================

btnBack?.addEventListener("click", () => {
  bookingForm.hidden = true;
  quoteForm.hidden = false;
});

// ==========================
// STRIPE PAYMENT
// ==========================

bookingForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!lastQuote) return;

  const fd = new FormData(bookingForm);

  const booking = {
    ...lastQuote.payload,
    quotedTotal: lastQuote.result.total,
    quotedDeposit: lastQuote.result.deposit,
    quotedRemaining: lastQuote.result.remaining,
    name: fd.get("name"),
    phone: fd.get("phone"),
    email: fd.get("email") || "",
    notes: fd.get("notes") || "",
  };

  const submitBtn = bookingForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = "Redirecting to payment…";

  try {
    const out = await postJSON("/api/create-checkout-session", booking);
    if (!out?.url) throw new Error("No Stripe URL returned");
    window.location.href = out.url;
  } catch (err) {
    alert("Sorry — payment could not start. Please try again.");
    console.error(err);
    submitBtn.disabled = false;
    submitBtn.textContent = "Confirm booking";
  }
});

// ==========================
// RESET
// ==========================

btnNewQuote?.addEventListener("click", () => {
  location.reload();
});

