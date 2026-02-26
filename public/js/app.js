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

const pickupPostcodeHidden = document.getElementById("pickupPostcode");
const dropoffPostcodeHidden = document.getElementById("dropoffPostcode");

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
}

function clearDropoffLocationFields() {
  if (dropoffFullAddressHidden) dropoffFullAddressHidden.value = "";
  if (dropoffPlaceIdHidden) dropoffPlaceIdHidden.value = "";
  if (dropoffLatHidden) dropoffLatHidden.value = "";
  if (dropoffLngHidden) dropoffLngHidden.value = "";
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
  if (!quoteForm.reportValidity()) return;

  const payload = getQuotePayload();

  if (!isLikelyValidPostcode(payload.pickup) || !isLikelyValidPostcode(payload.dropoff)) {
    alert("Please enter valid UK postcodes for pickup and delivery.");
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

