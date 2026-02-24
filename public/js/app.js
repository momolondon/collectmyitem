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

const priceBox = $("priceBox");
const priceValue = $("priceValue");
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
// HELPERS
// ==========================

function cleanPostcode(pc) {

return String(pc || "")
.trim()
.toUpperCase()
.replace(/\s+/g, "");

}



function guessZoneFromPostcode(pc) {

const s = cleanPostcode(pc);

const m = s.match(/[1-9]/);

if (!m) return null;

const n = parseInt(m[0], 10);

if (n >= 1 && n <= 6) return n;

return null;

}



function clampNumber(v, min, max, fallback) {

const n = Number(v);

if (!Number.isFinite(n)) return fallback;

return Math.min(max, Math.max(min, n));

}





// ==========================
// CONGESTION CHARGE
// ==========================

function timeWindowToRange(timeWindow) {

switch (timeWindow) {

case "morning": return [480, 720];

case "afternoon": return [720, 1020];

case "evening": return [1020, 1260];

default: return [0, 1440];

}

}



function rangesOverlap(aStart, aEnd, bStart, bEnd) {

return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);

}



function congestionChargeApplies(dateStr, timeWindow) {

if (!dateStr) return false;

const d = new Date(dateStr);

const day = d.getDay();

const [winStart, winEnd] = timeWindowToRange(timeWindow);



// Mon–Fri

if (day >= 1 && day <= 5)

return rangesOverlap(winStart, winEnd, 420, 1080);



// Sat Sun

return rangesOverlap(winStart, winEnd, 720, 1080);

}





// ==========================
// PRICE CALCULATION
// ==========================

function estimatePrice(payload) {

const baseBySize = {

small: 35,

medium: 55,

large: 75,

xl: 95

};



const base = baseBySize[payload.itemSize] ?? 55;



// MULTIPLE ITEMS
const count = clampNumber(payload.itemCount, 1, 30, 1);
const extraCostPerItem = 8;
const extraItems = (count - 1) * extraCostPerItem;
// STAIRS
const stairs =
(payload.stairsPickup === "yes" ? 10 : 0) +
(payload.stairsDropoff === "yes" ? 10 : 0);
// ZONE
const z1 = guessZoneFromPostcode(payload.pickup);
const z2 = guessZoneFromPostcode(payload.dropoff);
const zone = Math.max(z1 || 1, z2 || 1);
const zoneCost = (zone - 1) * 3;


// CONGESTION

const congestion = congestionChargeApplies(

payload.date,

payload.timeWindow

) ? 18 : 0;



const total = Math.round(

(base + extraItems + stairs + zoneCost + congestion) / 5

) * 5;



const breakdown = [

`Base — £${base}`,

count > 1 && `Extra items — £${extraItems}`,

stairs > 0 && `Stairs — £${stairs}`,

zoneCost > 0 && `Travel — £${zoneCost}`,

congestion > 0 && `Congestion Charge — £18`

].filter(Boolean);



return {

price: total,

zone: `Zones 1–${zone}`,

breakdown,

note: "Includes van + driver"

};

}





// ==========================
// SHOW PRICE
// ==========================

function showPriceUI({ price, zone, breakdown, note }) {
  // ✅ Guard: if any element missing, don’t crash the whole pricing
  if (!priceBox || !priceValue || !zoneBadge || !priceBreakdown || !priceNote) {
    console.error("Missing price UI elements:", {
      priceBox, priceValue, zoneBadge, priceBreakdown, priceNote
    });
    alert("Price UI error: missing elements in HTML (IDs). Check priceBox/priceValue/zoneBadge/priceBreakdown/priceNote.");
    return;
  }

  priceValue.textContent = `£${price}`;
  zoneBadge.textContent = zone || "London";
  priceBreakdown.innerHTML = (breakdown || []).map(line => `<div>• ${line}</div>`).join("");
  priceNote.textContent = note || "Includes van + driver. London only.";

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

pickup: fd.get("pickup"),
dropoff: fd.get("dropoff"),
itemType: fd.get("itemType"),    //remove this if you delete dropdown
itemSize: fd.get("itemSize"),
itemCount: fd.get("itemCount") || 1,
itemDetails: fd.get("itemDetails") || "",
congestionZone: fd.get("congestionZone") || "no",  //default no
stairsPickup: fd.get("stairsPickup") || "no",
stairsDropoff: fd.get("stairsDropoff") || "no",
date: fd.get("date")|| "",
timeWindow: fd.get("timeWindow") || "any",

};

}


// ==========================
// GET PRICE BUTTON
// ==========================

btnGetPrice?.addEventListener("click", async () => {
 if (!quoteForm.reportValidity()) return;

 if (btnBook) btnBook.disabled = true;
 if (priceBox && !priceBox.hidden) smoothHide(priceBox);

 const payload = getQuotePayload();

 btnGetPrice.disabled = true;
 btnGetPrice.textContent = "Calculating…";

 try {
   let result;

   // Try backend first, fallback to estimatePrice if backend fails
   try {
     result = await postJSON("/api/price", payload);
     if (!result || typeof result.price !== "number") {
       throw new Error("Bad /api/price response");
     }
   } catch {
     result = estimatePrice(payload);
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

btnBook.addEventListener("click", () => {

quoteForm.hidden = true;

bookingForm.hidden = false;

});





// ==========================
// BACK BUTTON
// ==========================

btnBack.addEventListener("click", () => {

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
    // no "price" needed now; server recalculates. But it’s OK to include it:
    price: lastQuote.result.price,
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













































