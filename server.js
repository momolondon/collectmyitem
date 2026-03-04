const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
// Load .env from project root (next to server.js) regardless of cwd
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Stripe = require("stripe");
console.log("Stripe key loaded?", Boolean(process.env.STRIPE_SECRET_KEY));
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { handleCheckoutSessionCompleted } = require("./webhook");

const app = express();
const PORT = process.env.PORT || 4242;

const BOOKINGS_FILE = path.join(__dirname, "bookings.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Unified pricing constants
// Pricing model:
// total =
//   70 +
//   (distance × 1.60) +
//   (congestion ? 18 : 0) +
//   (helper ? 30 : 0)
const BASE_FEE = 35; // £
const PER_MILE_RATE = 1.6; // £ per mile
const CONGESTION_FEE = 18; // £ flat
const HELPER_FEE = 30; // £ flat
const BULKY_BAND_FEE = 15; // £ per 2-item band above first 2
const MIN_TOTAL = 60; // Never allow total below £60

// Bulky items: sofa, corner sofa, armchair, dining table, bed frame, mattress, wardrobe,
// chest of drawers, desk, tv stand, fridge, freezer, washing machine, tumble dryer,
// dishwasher, oven, microwave, vacuum cleaner, sound system, TV,
// plus any custom items from the quote form
const BULKY_ITEM_TERMS = [
  "corner sofa", "sofa", "armchair", "dining table", "dining chairs",
  "bed frame", "mattress", "wardrobe", "chest of drawers", "desk", "tv stand",
  "coffee table", "bookshelf", "bedside table",
  "fridge", "freezer", "washing machine", "tumble dryer",
  "dishwasher", "oven", "microwave", "vacuum cleaner", "sound system", "tv",
];

function countBulkyUnits(items) {
  if (!Array.isArray(items)) return 0;
  let units = 0;
  for (const item of items) {
    const name = String(item?.name || "").toLowerCase();
    const qty = Math.max(0, parseInt(item?.qty, 10) || 1);
    const isCustom = item && item.isCustom === true;
    const isBulkyByName = BULKY_ITEM_TERMS.some((term) => name.includes(term));
    const isBulky = isCustom || isBulkyByName;
    if (isBulky) units += qty;
  }
  return units;
}

function calcBulkyCharge(bulkyUnits) {
  if (bulkyUnits <= 2) return 0;
  const extraUnits = bulkyUnits - 2;
  return extraUnits * BULKY_BAND_FEE;
}

// Box charge: first 5 free, then £5 per extra box
const BOX_FREE_LIMIT = 5;
const BOX_EXTRA_FEE = 5; // £ per box above limit

const BOX_ITEM_TERMS = [
  "box",
  "boxes",
  "carton",
  "suitcase",
  "suitcases",
  "bicycle",
  "bycicle",
  "bike",
  "bag",
  "bags",
];

function countBoxUnits(items) {
  if (!Array.isArray(items)) return 0;
  let units = 0;
  for (const item of items) {
    const name = String(item?.name || "").toLowerCase();
    const qty = Math.max(0, parseInt(item?.qty, 10) || 1);
    const isBox = BOX_ITEM_TERMS.some((term) => name.includes(term));
    if (isBox) units += qty;
  }
  return units;
}

function calcBoxesFee(boxUnits) {
  return boxUnits <= BOX_FREE_LIMIT ? 0 : (boxUnits - BOX_FREE_LIMIT) * BOX_EXTRA_FEE;
}

// Bag charge: first 5 free, then £5 per extra bag
const BAG_FREE_LIMIT = 5;
const BAG_EXTRA_FEE = 5; // £ per bag above limit

const BAG_ITEM_TERMS = ["bag", "bags"];

function countBagUnits(items) {
  if (!Array.isArray(items)) return 0;
  let units = 0;
  for (const item of items) {
    const name = String(item?.name || "").toLowerCase();
    const qty = Math.max(0, parseInt(item?.qty, 10) || 1);
    const isBag = BAG_ITEM_TERMS.some((term) => name.includes(term));
    if (isBag) units += qty;
  }
  return units;
}

function calcBagsFee(bagUnits) {
  return bagUnits <= BAG_FREE_LIMIT ? 0 : (bagUnits - BAG_FREE_LIMIT) * BAG_EXTRA_FEE;
}

/** Resolve items array from body.items or body.itemsList (server recomputes, does not trust client) */
function resolveItems(body) {
  if (Array.isArray(body?.items)) return body.items;
  try {
    const raw = body?.itemsList;
    if (typeof raw === "string" && raw.trim()) return JSON.parse(raw);
    if (Array.isArray(raw)) return raw;
  } catch (_) {}
  return [];
}

// Deposit logic: platform commission = 25% of total, deposit equals commission
const DEPOSIT_PERCENT = 0.25;
const MIN_DEPOSIT = 15; // £ (25% of MIN_TOTAL 60)
const LONDON_CENTER_LAT = 51.5074;
const LONDON_CENTER_LNG = -0.1278;
const LONDON_ZONE_RADIUS_MILES = 17; // rough "zones 1-6" radius

// ------------------------------
// Health check (BEFORE raw webhook - no JSON body)
// ------------------------------

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ------------------------------
// Webhook MUST be raw and BEFORE express.json
// ------------------------------

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.log("❌ Webhook Error: STRIPE_WEBHOOK_SECRET not set");
    return res.sendStatus(500);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log("❌ Webhook Error:", err.message);
    return res.sendStatus(400);
  }

  const bookingRef = event.data?.object?.metadata?.bookingRef;
  console.log("[webhook received] event=" + event.type + " bookingRef=" + (bookingRef || "—"));

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const ref = session.metadata?.bookingRef;

    if (!ref) {
      console.log("[webhook] No bookingRef in metadata, ignoring");
      return res.json({ received: true });
    }

    // Only mark paid when Stripe confirms payment
    if (session.payment_status !== "paid") {
      console.log("[webhook] payment_status is '" + (session.payment_status || "—") + "', not marking as paid");
      return res.json({ received: true });
    }

    const bookings = readBookings();
    const booking = bookings.find((b) => b.bookingRef === ref);
    if (!booking) {
      console.log("[webhook] No booking found for bookingRef=" + ref);
      return res.json({ received: true });
    }

    booking.status = "paid_deposit";
    booking.jobStatus = booking.jobStatus ?? "pending";
    booking.depositPaidAt = new Date().toISOString();
    writeBookings(bookings);
    console.log("[booking marked paid] bookingRef=" + ref);

    // Send admin notification + customer confirmation emails (after payment confirmed)
    handleCheckoutSessionCompleted(session, booking).catch((err) => {
      console.error("Webhook email error:", err);
    });
  }

  res.json({ received: true });
});

// ------------------------------
// Normal middleware AFTER webhook
// ------------------------------

app.use(cors());
app.use(express.json());

// ------------------------------
// Basic Auth for admin panel
// ------------------------------

function basicAuth(req, res, next) {
  const expectedUser = (process.env.ADMIN_USERNAME || "").trim();
  const expectedPass = (process.env.ADMIN_PASSWORD || "").trim();
  if (!expectedUser || !expectedPass) {
    console.warn("⚠️ ADMIN_USERNAME and ADMIN_PASSWORD must be set for admin protection.");
    return res.status(401).setHeader("WWW-Authenticate", 'Basic realm="Admin"').setHeader("Content-Type", "application/json").json({ error: "Unauthorized" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return res.status(401).setHeader("WWW-Authenticate", 'Basic realm="Admin"').setHeader("Content-Type", "application/json").json({ error: "Unauthorized" });
  }

  let decoded;
  try {
    decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  } catch {
    return res.status(401).setHeader("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
  }

  const colonIndex = decoded.indexOf(":");
  const username = (colonIndex >= 0 ? decoded.slice(0, colonIndex) : decoded).trim();
  const password = (colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "").trim();

  if (username !== expectedUser || password !== expectedPass) {
    return res.status(401).setHeader("WWW-Authenticate", 'Basic realm="Admin"').setHeader("Content-Type", "application/json").json({ error: "Unauthorized" });
  }

  next();
}

// Admin routes BEFORE static (so /admin and /admin/booking/:id are matched)
app.use("/admin", basicAuth);
app.use("/api/admin", basicAuth);

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin", "index.html"));
});
app.get("/admin/booking/:id", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin", "booking.html"));
});

// Serve static frontend
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/new-form", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "new-form.html"));
});
app.get("/quote", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "quote.html"));
});
app.get("/details", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "details.html"));
});

// ------------------------------
// Booking file helpers
// ------------------------------

function readBookings() {
  if (!fs.existsSync(BOOKINGS_FILE)) return [];
  try {
    const raw = fs.readFileSync(BOOKINGS_FILE, "utf8");
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to read bookings.json", err);
    return [];
  }
}

function writeBookings(bookings) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}

const PLATFORM_COMMISSION_PERCENT = 25;

function generateBookingId() {
  return "b" + Math.random().toString(36).slice(2, 11);
}

function enrichBookingWithAdminFields(booking, data) {
  const total = Number(data.total ?? booking.total ?? 0);
  const platformProfit = Math.round(total * 0.25);
  const driverPayoutVal = total - platformProfit;

  return {
    ...booking,
    ...data,
    id: booking.id ?? data.id ?? generateBookingId(),
    createdAt: booking.createdAt ?? data.createdAt ?? new Date().toISOString(),
    customerPrice: data.customerPrice ?? booking.customerPrice ?? total,
    deposit: data.deposit ?? booking.deposit ?? 0,
    remainingBalance: data.remainingBalance ?? booking.remainingBalance ?? (data.remaining ?? booking.remaining ?? 0),
    platformProfit: booking.platformProfit ?? data.platformProfit ?? platformProfit,
    driverPayout: booking.driverPayout ?? data.driverPayout ?? driverPayoutVal,
    driverPaid: booking.driverPaid ?? data.driverPaid ?? false,
    driverPaidAt: booking.driverPaidAt ?? data.driverPaidAt ?? null,
    status: data.status ?? booking.status ?? "pending",
  };
}

function upsertBooking(data) {
  const bookings = readBookings();
  let booking = bookings.find((b) => b.bookingRef === data.bookingRef);
  const now = new Date().toISOString();

  if (!booking) {
    const total = Number(data.total ?? 0);
    const deposit = Number(data.deposit ?? 0);
    const remaining = Number(data.remaining ?? total - deposit);
    const platformProfit = Math.round(total * 0.25);
    const driverPayoutVal = total - platformProfit;

    booking = {
      ...data,
      id: generateBookingId(),
      createdAt: now,
      updatedAt: now,
      status: data.status || "pending_payment",
      jobStatus: data.jobStatus ?? "pending",
      customerPrice: total,
      deposit,
      remainingBalance: remaining,
      platformProfit,
      driverPayout: driverPayoutVal,
      driverPaid: false,
      driverPaidAt: null,
      pickupAddress: data.pickupFullAddress || data.pickupAddress || data.pickup || "",
      dropoffAddress: data.dropoffFullAddress || data.dropoffAddress || data.dropoff || "",
      customerNote: (data.customerNote ?? data.note ?? data.notes ?? "").trim(),
    };
    bookings.push(booking);
  } else {
    const updates = { ...data, updatedAt: now };
    if (data.total != null && booking.customerPrice == null) {
      const total = Number(data.total);
      updates.customerPrice = total;
      updates.platformProfit = Math.round(total * 0.25);
      updates.driverPayout = total - updates.platformProfit;
    }
    if (data.pickupFullAddress) updates.pickupAddress = data.pickupFullAddress;
    if (data.dropoffFullAddress) updates.dropoffAddress = data.dropoffFullAddress;
    Object.assign(booking, updates);
  }

  writeBookings(bookings);
  return booking;
}

// ------------------------------
// Validation & pricing helpers
// ------------------------------

function cleanPostcode(pc) {
  return String(pc || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

/** Returns true if the string is a valid UK postcode format. */
function isValidPostcode(pc) {
  const s = cleanPostcode(pc);
  return /^[A-Z]{1,2}\d[A-Z0-9]?\d[A-Z]{2}$/.test(s);
}

/** UK mobile: 07xxx xxxxxx or +447xxxxxxxxx — 11 digits after +44 or starting 07 */
function isValidUKPhone(str) {
  const s = String(str || "").trim().replace(/\s+/g, "");
  if (!s) return false;
  if (/^\+447\d{9}$/.test(s)) return true;
  if (/^07\d{9}$/.test(s)) return true;
  return false;
}

/**
 * London Congestion Charge: allowed postcode outward codes only.
 * Exact match only (e.g. SE1 in, SE12/SE13/etc out).
 */
const CONGESTION_ZONE_PREFIXES = [
  "WC1", "WC2", "EC1", "EC2", "EC3", "EC4",
  "W1", "SW1", "SE11", "SE1",
];

/** Returns true if the postcode outward code is exactly in the congestion zone list. */
function isPostcodeInCongestionArea(pc) {
  const s = cleanPostcode(pc);
  if (!s) return false;
  // Extract outward: full postcode has 3-char inward at end; short form is outward only
  const outward = s.length >= 5 ? s.slice(0, -3) : s;
  return CONGESTION_ZONE_PREFIXES.includes(outward);
}

/**
 * Returns true if the given date/time falls within London Congestion Charge hours:
 * Mon–Fri: 7:00–18:00
 * Sat–Sun: 12:01–18:00
 * dateTime is treated as local (Europe/London). Use buildDateTimeForCongestion for consistency.
 */
function isWithinCongestionChargingHours(dateTime) {
  if (!dateTime || !(dateTime instanceof Date) || Number.isNaN(dateTime.getTime())) return false;
  const day = dateTime.getDay(); // 0=Sun, 6=Sat
  const hours = dateTime.getHours();
  const minutes = dateTime.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  if (day >= 1 && day <= 5) {
    // Mon–Fri: 7am (420 min) to 6pm (1080 min) inclusive
    return totalMinutes >= 420 && totalMinutes < 1080;
  }
  // Sat–Sun: 12:01pm (721 min) to 6pm (1080 min) inclusive
  return totalMinutes >= 721 && totalMinutes < 1080;
}

/**
 * Returns true if the postcode is in the congestion zone area list.
 * Pricing rule: apply congestion only if pickup OR dropoff inside congestion zone.
 * Time of day is ignored for pricing.
 */
function isCongestionZone(postcode) {
  return isPostcodeInCongestionArea(postcode);
}

/**
 * Build a representative Date for congestion charging from date (YYYY-MM-DD) and timeWindow.
 * Returns null if no date, so caller should not apply congestion charge.
 */
function buildDateTimeForCongestion(dateStr, timeWindow) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const datePart = String(dateStr).trim();
  if (!datePart) return null;
  // Parse YYYY-MM-DD as local date, then set time per timeWindow
  const [y, m, d] = datePart.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return null;
  const tw = (timeWindow || "any").toLowerCase();
  if (tw === "morning") {
    date.setHours(10, 0, 0, 0);
  } else if (tw === "afternoon") {
    date.setHours(14, 0, 0, 0);
  } else if (tw === "evening") {
    date.setHours(17, 30, 0, 0);
  } else {
    date.setHours(12, 30, 0, 0); // noon as default for "any"
  }
  return date;
}

/** Format UK postcode for Google APIs: add space before inward code and append ", UK" */
function formatPostcodeForGoogle(pc) {
  const cleaned = cleanPostcode(pc);
  if (!cleaned) return "";
  // UK outward (e.g. SE6) + inward (e.g. 2BG) — insert space before last 3 chars if missing
  if (cleaned.length >= 5 && cleaned.charAt(cleaned.length - 4) !== " ") {
    return cleaned.slice(0, -3) + " " + cleaned.slice(-3) + ", UK";
  }
  return cleaned + ", UK";
}

/**
 * Reverse geocode lat/lng to get UK postcode via Google Geocoding API.
 * Returns postcode string or "" if not found / API unavailable.
 */
async function reverseGeocodeToPostcode(lat, lng) {
  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!apiKey || lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  const latlng = `${Number(lat)},${Number(lng)}`;
  const params = new URLSearchParams({ latlng, key: apiKey });
  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return "";
    const data = await resp.json();
    const result = data?.results?.[0];
    if (!result || !result.address_components) return "";
    const components = result.address_components;
    for (let i = 0; i < components.length; i++) {
      const types = components[i].types || [];
      if (types.indexOf("postal_code") !== -1) {
        const pc = (components[i].long_name || "").trim();
        return pc ? cleanPostcode(pc) : "";
      }
    }
  } catch (_) {}
  return "";
}

function toDistanceLocation(postcode, coords) {
  const hasCoords =
    coords &&
    typeof coords.lat === "number" &&
    Number.isFinite(coords.lat) &&
    typeof coords.lng === "number" &&
    Number.isFinite(coords.lng);

  if (hasCoords) {
    return `${coords.lat},${coords.lng}`;
  }

  return formatPostcodeForGoogle(postcode);
}

async function calculateDistanceMiles(
  pickupPostcode,
  dropoffPostcode,
  pickupCoords,
  dropoffCoords
) {
  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!apiKey) {
    // No key configured – fall back to minimum-distance pricing only
    return 0;
  }

  const origin = toDistanceLocation(pickupPostcode, pickupCoords);
  const dest = toDistanceLocation(dropoffPostcode, dropoffCoords);

  if (!origin || !dest) return 0;

  const params = new URLSearchParams({
    units: "imperial",
    origins: origin,
    destinations: dest,
    key: apiKey,
  });

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Distance API HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const element = data?.rows?.[0]?.elements?.[0];

  if (!element || element.status !== "OK" || !element.distance) {
    throw new Error(`Distance API element status: ${element?.status}`);
  }

  const miles = element.distance.value / 1609.344;
  if (!Number.isFinite(miles) || miles < 0) return 0;

  // One decimal place is enough
  return Math.round(miles * 10) / 10;
}

async function calculatePricing(rawBody) {
  const body = rawBody || {};

  const pickup = cleanPostcode(body.pickup);
  const dropoff = cleanPostcode(body.dropoff);

  if (!pickup || !dropoff) {
    throw new Error("Pickup and delivery postcodes are required.");
  }
  if (!isValidPostcode(pickup) || !isValidPostcode(dropoff)) {
    throw new Error("Please enter valid UK postcodes for pickup and delivery.");
  }

  // Service type is currently not used to change pricing, but we validate it for backwards compatibility.
  const serviceType = body.serviceType || "man_van";
  if (!["man_van", "house_removal"].includes(serviceType)) {
    throw new Error("Invalid service type. Please choose Man & Van or House Removal.");
  }

  const serviceLabel = serviceType === "house_removal" ? "House Removal" : "Man & Van";

  const pickupLat = Number(body.pickupLat);
  const pickupLng = Number(body.pickupLng);
  const dropoffLat = Number(body.dropoffLat);
  const dropoffLng = Number(body.dropoffLng);

  const pickupCoords =
    Number.isFinite(pickupLat) && Number.isFinite(pickupLng)
      ? { lat: pickupLat, lng: pickupLng }
      : null;
  const dropoffCoords =
    Number.isFinite(dropoffLat) && Number.isFinite(dropoffLng)
      ? { lat: dropoffLat, lng: dropoffLng }
      : null;

  let miles = 0;
  try {
    miles = await calculateDistanceMiles(pickup, dropoff, pickupCoords, dropoffCoords);
  } catch (err) {
    console.error("Distance calculation failed, using 0 miles:", err.message);
    miles = 0;
  }

  const distanceCharge = PER_MILE_RATE * miles;

  // Congestion charge: apply if pickup OR dropoff is inside congestion zone.
  const congestionApplied =
    (pickup && isCongestionZone(pickup)) || (dropoff && isCongestionZone(dropoff));
  const congestionFee = congestionApplied ? CONGESTION_FEE : 0;

  // Helper: only if explicitly selected in the payload
  const helperSelected =
    body.helper === true ||
    body.helper === "true" ||
    body.helper === "yes" ||
    body.helper === "on" ||
    body.helper === 1 ||
    body.helper === "1";
  const helperFee = helperSelected ? HELPER_FEE : 0;

  const items = resolveItems(body);
  const bulkyUnits = countBulkyUnits(items);
  const bulkyCharge = calcBulkyCharge(bulkyUnits);

  const boxUnits = countBoxUnits(items);
  const boxesFee = calcBoxesFee(boxUnits);

  const bagUnits = countBagUnits(items);
  const bagsFee = calcBagsFee(bagUnits);

  let total =
    BASE_FEE +
    distanceCharge +
    congestionFee +
    helperFee +
    bulkyCharge +
    boxesFee +
    bagsFee;
  if (!Number.isFinite(total)) {
    throw new Error("Calculated total is invalid.");
  }

  // Never allow total below minimum
  total = Math.max(MIN_TOTAL, Math.round(total));

  // Platform commission = exactly 25% of total. Deposit must equal commission.
  const platformProfit = Math.round(total * DEPOSIT_PERCENT);
  const deposit = platformProfit;

  const remaining = total - deposit;
  const driverPayout = total - platformProfit;

  const breakdown = [
    `Base fee: £${BASE_FEE.toFixed(0)}`,
    `Distance cost: £${Math.round(distanceCharge).toFixed(0)}`,
    `Congestion: £${congestionFee.toFixed(0)}`,
    `Helper: £${helperFee.toFixed(0)}`,
    bulkyCharge > 0 ? `Bulky items (${bulkyUnits}): £${bulkyCharge.toFixed(0)}` : null,
    boxesFee > 0 ? `Boxes extra: £${boxesFee.toFixed(0)}` : null,
    bagsFee > 0 ? `Bags extra: £${bagsFee.toFixed(0)}` : null,
    `Final total price: £${total.toFixed(0)}`,
  ].filter(Boolean);

  return {
    total,
    deposit,
    remaining,
    platformProfit,
    driverPayout,
    miles: Math.round(miles * 10) / 10,
    distanceCharge: Math.round(distanceCharge),
    base: BASE_FEE,
    boxesFee,
    bagsFee,
    bulkyFee: bulkyCharge,
    perMile: PER_MILE_RATE,
    congestionApplied,
    congestionFee,
    serviceType,
    serviceLabel,
    breakdown,
    note:
      "You pay only the deposit now. Remaining balance is paid directly to the driver on the day.",
  };
}

// ------------------------------
// New pricing form: lat/lng payload, base £35, £1.50/mile, congestion £18
// ------------------------------

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function isInLondonZones(lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const miles = haversineMiles(lat, lng, LONDON_CENTER_LAT, LONDON_CENTER_LNG);
  return miles <= LONDON_ZONE_RADIUS_MILES;
}

async function distanceMatrixMiles(originLat, originLng, destLat, destLng) {
  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!apiKey) return 0;
  const origin = `${originLat},${originLng}`;
  const dest = `${destLat},${destLng}`;
  const params = new URLSearchParams({
    units: "imperial",
    origins: origin,
    destinations: dest,
    key: apiKey,
  });
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Distance Matrix HTTP ${resp.status}`);
  const data = await resp.json();
  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK" || !element.distance) {
    throw new Error(`Distance Matrix: ${element?.status || "no data"}`);
  }
  const miles = element.distance.value / 1609.344;
  return Number.isFinite(miles) && miles >= 0 ? Math.round(miles * 10) / 10 : 0;
}

function isNewPricePayload(body) {
  const p = body?.pickup;
  const d = body?.dropoff;
  return (
    p &&
    typeof p === "object" &&
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    d &&
    typeof d === "object" &&
    typeof d.lat === "number" &&
    typeof d.lng === "number"
  );
}

async function calculatePricingNew(body) {
  const pickup = body.pickup || {};
  const dropoff = body.dropoff || {};
  const lat1 = Number(pickup.lat);
  const lng1 = Number(pickup.lng);
  const lat2 = Number(dropoff.lat);
  const lng2 = Number(dropoff.lng);

  if (!Number.isFinite(lat1) || !Number.isFinite(lng1) || !Number.isFinite(lat2) || !Number.isFinite(lng2)) {
    throw new Error("Pickup and dropoff must include valid lat and lng.");
  }

  let miles = 0;
  try {
    miles = await distanceMatrixMiles(lat1, lng1, lat2, lng2);
  } catch (err) {
    console.error("Distance Matrix failed, using 0 miles:", err.message);
  }

  const distanceCharge = PER_MILE_RATE * miles;

  // Resolve postcodes: use provided or derive from lat/lng (so congestion applies whenever we have a location)
  let pickupPostcode = pickup.postcode ? cleanPostcode(pickup.postcode) : "";
  let dropoffPostcode = dropoff.postcode ? cleanPostcode(dropoff.postcode) : "";
  if (!pickupPostcode && Number.isFinite(lat1) && Number.isFinite(lng1)) {
    pickupPostcode = await reverseGeocodeToPostcode(lat1, lng1);
  }
  if (!dropoffPostcode && Number.isFinite(lat2) && Number.isFinite(lng2)) {
    dropoffPostcode = await reverseGeocodeToPostcode(lat2, lng2);
  }

  // Congestion: apply when pickup OR dropoff is inside congestion zone (using postcode from payload or reverse-geocoded)
  const congestionApplied =
    (pickupPostcode && isCongestionZone(pickupPostcode)) ||
    (dropoffPostcode && isCongestionZone(dropoffPostcode));
  const congestionFee = congestionApplied ? CONGESTION_FEE : 0;

  // Helpers: 0, 1, or 2 — helpers * £30
  const helpersCount = Math.min(2, Math.max(0, parseInt(body.helpers, 10) || 0));
  const helperFee = helpersCount * HELPER_FEE;

  // Stairs: if helpers >= 1 then stairs fee = 0; else £15 pickup + £15 dropoff when yes
  const stairsPickup = body.stairsPickup === "yes" || body.stairsPickup === true;
  const stairsDropoff = body.stairsDropoff === "yes" || body.stairsDropoff === true;
  const STAIRS_FEE = 15;
  const stairsPickupFee = helpersCount >= 1 ? 0 : (stairsPickup ? STAIRS_FEE : 0);
  const stairsDropoffFee = helpersCount >= 1 ? 0 : (stairsDropoff ? STAIRS_FEE : 0);
  const stairsTotal = stairsPickupFee + stairsDropoffFee;

  const items = resolveItems(body);
  const bulkyUnits = countBulkyUnits(items);
  const bulkyCharge = calcBulkyCharge(bulkyUnits);

  const boxUnits = countBoxUnits(items);
  const boxesFee = calcBoxesFee(boxUnits);

  const bagUnits = countBagUnits(items);
  const bagsFee = calcBagsFee(bagUnits);

  let total =
    BASE_FEE +
    distanceCharge +
    congestionFee +
    helperFee +
    stairsTotal +
    bulkyCharge +
    boxesFee +
    bagsFee;
  if (!Number.isFinite(total)) {
    throw new Error("Calculated total is invalid.");
  }

  total = Math.max(MIN_TOTAL, Math.round(total));

  // Platform commission = exactly 25% of total. Deposit must equal commission.
  const platformProfit = Math.round(total * DEPOSIT_PERCENT);
  const deposit = platformProfit;

  const remaining = total - deposit;
  const driverPayout = total - platformProfit;

  const breakdown = [
    `Base fee: £${BASE_FEE.toFixed(0)}`,
    `Distance cost: £${Math.round(distanceCharge).toFixed(0)}`,
    `Congestion: £${congestionFee.toFixed(0)}`,
    helperFee > 0 ? `Helpers (${helpersCount}): £${helperFee.toFixed(0)}` : null,
    stairsPickupFee > 0 ? `Stairs pickup: £${stairsPickupFee.toFixed(0)}` : null,
    stairsDropoffFee > 0 ? `Stairs dropoff: £${stairsDropoffFee.toFixed(0)}` : null,
    bulkyCharge > 0 ? `Bulky items (${bulkyUnits}): £${bulkyCharge.toFixed(0)}` : null,
    boxesFee > 0 ? `Boxes extra: £${boxesFee.toFixed(0)}` : null,
    bagsFee > 0 ? `Bags extra: £${bagsFee.toFixed(0)}` : null,
    `Final total price: £${total.toFixed(0)}`,
  ].filter(Boolean);

  return {
    total,
    deposit,
    remaining,
    platformProfit,
    driverPayout,
    miles: Math.round(miles * 10) / 10,
    distanceCharge: Math.round(distanceCharge),
    baseFee: BASE_FEE,
    boxesFee,
    bagsFee,
    bulkyFee: bulkyCharge,
    perMile: PER_MILE_RATE,
    congestionApplied,
    congestionFee,
    helperFee,
    stairsPickupFee,
    stairsDropoffFee,
    breakdown,
    note: "Pay the deposit now. Remaining balance is paid to the driver on the day.",
  };
}

// ------------------------------
// Price endpoint
// ------------------------------

app.post("/api/price", async (req, res) => {
  try {
    const body = req.body || {};
    const pricing = isNewPricePayload(body)
      ? await calculatePricingNew(body)
      : await calculatePricing(body);
    res.json(pricing);
  } catch (e) {
    const status = /required|invalid|Please|must include/.test(e.message) ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ------------------------------
// Stripe checkout session (deposit only)
// ------------------------------

async function handleCheckout(req, res) {
  try {
    const body = req.body || {};
    const isNewFlow = isNewPricePayload(body);

    // Phone number is REQUIRED — do not create Stripe session without it
    const phone = (body.customerPhone || body.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Resolve pickup/dropoff postcodes and addresses
    let pickupPostcode = "";
    let dropoffPostcode = "";
    let pickupFullAddress = "";
    let dropoffFullAddress = "";

    if (isNewFlow) {
      const p = body.pickup || {};
      const d = body.dropoff || {};
      pickupPostcode = p.postcode ? cleanPostcode(p.postcode) : "";
      dropoffPostcode = d.postcode ? cleanPostcode(d.postcode) : "";
      pickupFullAddress = p.formattedAddress || "";
      dropoffFullAddress = d.formattedAddress || "";
    } else {
      pickupPostcode = cleanPostcode(body.pickup);
      dropoffPostcode = cleanPostcode(body.dropoff);
      pickupFullAddress = body.pickupFullAddress || "";
      dropoffFullAddress = body.dropoffFullAddress || "";
    }

    if (!pickupPostcode || !dropoffPostcode) {
      return res
        .status(400)
        .json({ error: "Pickup and delivery postcodes are required." });
    }
    if (!isValidPostcode(pickupPostcode) || !isValidPostcode(dropoffPostcode)) {
      return res
        .status(400)
        .json({ error: "Please enter valid UK postcodes for pickup and delivery." });
    }

    if (!isNewFlow && body.serviceType && !["man_van", "house_removal"].includes(body.serviceType)) {
      return res
        .status(400)
        .json({ error: "Invalid service type. Please choose Man & Van or House Removal." });
    }

    if (!isNewFlow && body.serviceType === "house_removal" && !body.houseSize) {
      return res
        .status(400)
        .json({ error: "Please select a valid property size for house removal." });
    }

    const customerName = (body.customerName || body.name || "").trim();
    const customerPhone = (body.customerPhone || body.phone || "").trim();
    const customerEmail = (body.customerEmail || body.email || "").trim();
    const customerNote = (body.note || body.customerNote || body.notes || "").trim();

    if (!customerName || !customerPhone) {
      return res
        .status(400)
        .json({ error: "Name and mobile number are required to book." });
    }
    if (!isValidUKPhone(customerPhone)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid UK mobile number (e.g. 07700 900123)." });
    }

    // Idempotency / duplicate booking protection
    const allBookings = readBookings();
    let bookingRef = body.bookingRef;
    let existingBooking = null;

    if (bookingRef) {
      existingBooking = allBookings.find((b) => b.bookingRef === bookingRef);
      if (existingBooking) {
        if (existingBooking.status === "paid_deposit") {
          return res
            .status(400)
            .json({ error: "Deposit has already been paid for this booking." });
        }
        if (existingBooking.stripeSessionId && existingBooking.stripeSessionUrl) {
          return res.json({
            url: existingBooking.stripeSessionUrl,
            bookingRef: existingBooking.bookingRef,
          });
        }
      }
    }

    if (!bookingRef) {
      do {
        bookingRef = `CMI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      } while (allBookings.some((b) => b.bookingRef === bookingRef));
    }

    const pricing = isNewFlow
      ? await calculatePricingNew(body)
      : await calculatePricing({
          pickup: pickupPostcode,
          dropoff: dropoffPostcode,
          serviceType: body.serviceType,
          houseSize: body.houseSize,
          pickupLat: body.pickupLat,
          pickupLng: body.pickupLng,
          dropoffLat: body.dropoffLat,
          dropoffLng: body.dropoffLng,
        });

    // Deposit must equal exactly 25% of total (no minimum rule)
    const amountPence = Math.round(pricing.deposit * 100);
    if (!amountPence || amountPence <= 0) {
      return res.status(400).json({ error: "Invalid deposit amount." });
    }

    upsertBooking({
      bookingRef,
      pickup: pickupPostcode,
      dropoff: dropoffPostcode,
      pickupFullAddress: pickupFullAddress || pickupPostcode,
      dropoffFullAddress: dropoffFullAddress || dropoffPostcode,
      serviceType: body.serviceType || "man_van",
      houseSize: body.houseSize || "",
      stairsPickup: body.stairsPickup || "no",
      stairsDropoff: body.stairsDropoff || "no",
      date: body.date || "",
      timeWindow: body.timeWindow || "any",
      helpers: body.helpers ?? body.helper,
      customerName,
      customerPhone,
      customerEmail,
      customerNote,
      notes: customerNote,
      name: customerName,
      phone: customerPhone,
      email: customerEmail,
      items: resolveItems(body),
      itemsList: body.itemsList,
      itemCount: body.itemCount,
      itemDetails: body.itemDetails,
      total: pricing.total,
      deposit: pricing.deposit,
      remaining: pricing.remaining,
      platformProfit: pricing.platformProfit,
      driverPayout: pricing.driverPayout,
      miles: pricing.miles,
      breakdown: pricing.breakdown,
      baseFee: pricing.base ?? pricing.baseFee,
      distanceCharge: pricing.distanceCharge,
      congestionFee: pricing.congestionFee,
      helperFee: pricing.helperFee,
      stairsPickupFee: pricing.stairsPickupFee,
      stairsDropoffFee: pricing.stairsDropoffFee,
      bulkyFee: pricing.bulkyFee ?? pricing.bulkyCharge,
      boxesFee: pricing.boxesFee,
      bagsFee: pricing.bagsFee,
      status: "pending_payment",
    });

    console.log("[booking created] bookingRef=" + bookingRef);

    // Only pass customer_email to Stripe if valid (prevents "email_invalid" error)
    const isValidEmail = (e) => {
      const s = String(e || "").trim();
      if (!s) return false;
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    };
    const checkoutOptions = {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: `Collect My Item - ${bookingRef}`,
            },
            unit_amount: amountPence,
          },
          quantity: 1,
        },
      ],
      metadata: { bookingRef },
      success_url: `${BASE_URL}/success.html?bookingRef=${encodeURIComponent(bookingRef)}`,
      cancel_url: `${BASE_URL}/cancel.html`,
    };
    if (isValidEmail(customerEmail)) {
      checkoutOptions.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(checkoutOptions);

    console.log("[stripe session created] bookingRef=" + bookingRef + " sessionId=" + session.id);

    // Store Stripe session info to prevent duplicate sessions for the same bookingRef
    upsertBooking({
      bookingRef,
      stripeSessionId: session.id,
      stripeSessionUrl: session.url,
    });

    res.json({
      url: session.url,
      bookingRef,
    });
  } catch (err) {
    console.log("Stripe / checkout error:", err);
    res.status(500).json({
      error: err.message || "Unexpected error creating checkout session.",
    });
  }
}

app.post("/create-checkout-session", handleCheckout);
app.post("/api/create-checkout-session", handleCheckout);

// ------------------------------
// Google Maps config for frontend (Places + Distance Matrix)
// ------------------------------

app.get("/api/maps-config", (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_BROWSER_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "Google Maps API key is not configured on the server." });
  }
  res.json({ apiKey });
});

// ------------------------------
// Admin (local-only, no login)
// ------------------------------

function normalizeBookingForAdmin(b) {
  const total = Number(b.customerPrice ?? b.total ?? 0);
  const platformProfit = Number(b.platformProfit ?? Math.round(total * 0.25));
  const payout = Number(b.driverPayout ?? total - platformProfit);
  return {
    ...b,
    id: b.id ?? b.bookingRef,
    customerPrice: total,
    platformProfit,
    driverPayout: payout,
    driverPaid: Boolean(b.driverPaid),
    driverPaidAt: b.driverPaidAt ?? null,
    status: b.status ?? "pending",
    jobStatus: (b.jobStatus === "done" ? "done" : "pending"),
    pickupAddress: b.pickupAddress ?? b.pickup ?? "",
    dropoffAddress: b.dropoffAddress ?? b.dropoff ?? "",
    customerNote: (b.customerNote ?? b.notes ?? "").trim(),
  };
}

app.get("/api/admin/bookings", (req, res) => {
  const all = readBookings().map(normalizeBookingForAdmin);
  // Only show Stripe-confirmed paid bookings with valid bookingRef (hide test/failed/incomplete)
  const DISPLAY_STATUSES = ["paid", "paid_deposit"];
  const bookings = all.filter(
    (b) => b.bookingRef && String(b.bookingRef).trim() && DISPLAY_STATUSES.includes(b.status || "")
  );
  res.json(bookings);
});

// Find booking index by id or bookingRef (handles trim + optional decode)
function findBookingIndexByRef(bookings, ref) {
  const raw = (ref || "").trim();
  const decoded = (() => { try { return decodeURIComponent(raw); } catch (_) { return raw; } })();
  for (const r of [raw, decoded]) {
    if (!r) continue;
    const idx = bookings.findIndex(
      (b) =>
        (b.bookingRef && (b.bookingRef === r || String(b.bookingRef).trim() === r)) ||
        (b.id && String(b.id).trim() === r)
    );
    if (idx !== -1) return idx;
  }
  return -1;
}

app.get("/api/admin/booking/:id", (req, res) => {
  const ref = req.params.id;
  const bookings = readBookings();
  const idx = findBookingIndexByRef(bookings, ref);
  const booking = idx !== -1 ? bookings[idx] : null;
  if (!booking || !booking.bookingRef) {
    return res.status(404).json({ error: "Booking not found" });
  }
  // Only allow viewing paid bookings (or admin could see any by ref for debugging - keep as is for admin)
  const DISPLAY_STATUSES = ["paid", "paid_deposit"];
  if (!DISPLAY_STATUSES.includes(booking.status || "")) {
    return res.status(404).json({ error: "Booking not found" });
  }
  res.json(normalizeBookingForAdmin(booking));
});

app.post("/api/admin/booking/:id/mark-done", (req, res) => {
  const ref = req.params.id;
  const bookings = readBookings();
  const idx = findBookingIndexByRef(bookings, ref);
  if (idx === -1) {
    return res.status(404).json({ error: "Booking not found" });
  }
  const booking = bookings[idx];
  const now = new Date().toISOString();
  booking.jobStatus = "done";
  booking.updatedAt = now;
  try {
    writeBookings(bookings);
  } catch (err) {
    console.error("[mark-done] writeBookings failed:", err.message);
    return res.status(500).json({ error: "Failed to save booking: " + err.message });
  }
  res.json({ ok: true, booking: normalizeBookingForAdmin(booking) });
});

app.post("/api/admin/booking/:id/mark-driver-paid", (req, res) => {
  const ref = req.params.id;
  const bookings = readBookings();
  const idx = findBookingIndexByRef(bookings, ref);
  if (idx === -1) {
    return res.status(404).json({ error: "Booking not found" });
  }
  const booking = bookings[idx];
  const now = new Date().toISOString();
  booking.driverPaid = true;
  booking.driverPaidAt = now;
  booking.updatedAt = now;
  writeBookings(bookings);
  res.json({ ok: true, booking: normalizeBookingForAdmin(booking) });
});

app.delete("/api/admin/booking/:id", (req, res) => {
  const ref = req.params.id;
  const bookings = readBookings();
  const idx = findBookingIndexByRef(bookings, ref);
  if (idx === -1) {
    return res.status(404).json({ error: "Booking not found. Check that the booking ref is correct." });
  }
  bookings.splice(idx, 1);
  try {
    writeBookings(bookings);
  } catch (err) {
    console.error("[delete booking] writeBookings failed:", err.message);
    return res.status(500).json({ error: "Failed to delete booking: " + err.message });
  }
  res.json({ ok: true });
});

// ------------------------------
// Start server
// ------------------------------

// Optional: warn if Google Maps key is missing (needed for new-form and distance)
if (!process.env.GOOGLE_MAPS_SERVER_KEY) {
  console.warn("⚠️  GOOGLE_MAPS_SERVER_KEY is not set. New pricing form and distance calculation will be limited.");
}

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   Quote (Step 1): http://localhost:${PORT}/quote`);
  console.log(`   Admin (local): http://localhost:${PORT}/admin`);
});

