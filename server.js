const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 4242;

const BOOKINGS_FILE = path.join(__dirname, "bookings.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Pricing constants (legacy form)
const PER_MILE_RATE = 2; // £ per mile
const MIN_DEPOSIT = 25; // £
const CONGESTION_FEE = 18; // £ flat

// New pricing form constants
const NEW_BASE_FEE = 35;
const NEW_PER_MILE = 1.5;
const NEW_CONGESTION_FEE = 18;
const NEW_DEPOSIT_PERCENT = 0.25;
const LONDON_CENTER_LAT = 51.5074;
const LONDON_CENTER_LNG = -0.1278;
const LONDON_ZONE_RADIUS_MILES = 17; // rough "zones 1-6" radius

// ------------------------------
// Webhook MUST be raw and BEFORE express.json
// ------------------------------

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log("❌ Webhook Error:", err.message);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingRef = session.metadata?.bookingRef;

    console.log("✅ Deposit payment confirmed for:", bookingRef);

    if (bookingRef) {
      const bookings = readBookings();
      const booking = bookings.find((b) => b.bookingRef === bookingRef);
      if (booking) {
        booking.status = "paid_deposit";
        booking.depositPaidAt = new Date().toISOString();
        writeBookings(bookings);
      }
    }
  }

  res.json({ received: true });
});

// ------------------------------
// Normal middleware AFTER webhook
// ------------------------------

app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/new-form", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "new-form.html"));
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

function upsertBooking(data) {
  const bookings = readBookings();
  let booking = bookings.find((b) => b.bookingRef === data.bookingRef);
  const now = new Date().toISOString();

  if (!booking) {
    booking = {
      ...data,
      status: data.status || "pending_deposit",
      createdAt: now,
      updatedAt: now,
    };
    bookings.push(booking);
  } else {
    Object.assign(booking, data, { updatedAt: now });
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

function isValidPostcode(pc) {
  const s = cleanPostcode(pc);
  // Basic UK postcode pattern (good enough for validation here)
  return /^[A-Z]{1,2}\d[A-Z0-9]?\d[A-Z]{2}$/.test(s);
}

function isInCongestionZone(pc) {
  const s = cleanPostcode(pc);
  if (!s) return false;
  // Very simple approximation of central London congestion zone prefixes
  return (
    s.startsWith("EC1") ||
    s.startsWith("EC2") ||
    s.startsWith("EC3") ||
    s.startsWith("EC4") ||
    s.startsWith("WC1") ||
    s.startsWith("WC2") ||
    s.startsWith("W1") ||
    s.startsWith("SW1") ||
    s.startsWith("SE1") ||
    s.startsWith("E1") ||
    s.startsWith("N1")
  );
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
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
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
  const serviceType = body.serviceType;
  const houseSize = body.houseSize;

  if (!pickup || !dropoff) {
    throw new Error("Pickup and delivery postcodes are required.");
  }
  if (!isValidPostcode(pickup) || !isValidPostcode(dropoff)) {
    throw new Error("Please enter valid UK postcodes for pickup and delivery.");
  }

  if (!serviceType || !["man_van", "house_removal"].includes(serviceType)) {
    throw new Error("Invalid service type. Please choose Man & Van or House Removal.");
  }

  const houseRemovalBaseBySize = {
    studio: 200,
    "1_bed": 250,
    "2_bed": 350,
    "3_bed": 500,
    "4_bed": 700,
  };

  let base = 0;
  let minTotal = 0;
  let serviceLabel = "";

  if (serviceType === "man_van") {
    base = 60; // £60 base
    minTotal = 90; // minimum total
    serviceLabel = "Man & Van";
  } else {
    if (!houseSize || !houseRemovalBaseBySize[houseSize]) {
      throw new Error("Please select a valid property size for house removal.");
    }
    base = houseRemovalBaseBySize[houseSize];
    minTotal = 250;
    serviceLabel = "House Removal";
  }

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

  const congestionApplied =
    isInCongestionZone(pickup) || isInCongestionZone(dropoff);
  const congestionFee = congestionApplied ? CONGESTION_FEE : 0;

  let total = base + distanceCharge + congestionFee;
  if (!Number.isFinite(total)) {
    throw new Error("Calculated total is invalid.");
  }

  // Minimum totals for each service type
  total = Math.max(minTotal, Math.round(total));

  let deposit = total * 0.25;
  if (!Number.isFinite(deposit)) {
    throw new Error("Calculated deposit is invalid.");
  }
  deposit = Math.max(MIN_DEPOSIT, deposit);
  deposit = Math.round(deposit);

  const remaining = total - deposit;

  const breakdown = [
    `Service — ${serviceLabel}`,
    `Base — £${base.toFixed(0)}`,
    `Distance — £${Math.round(distanceCharge)} (${miles.toFixed(
      1
    )} miles @ £${PER_MILE_RATE}/mile)`,
    congestionApplied ? `Congestion Charge — £${CONGESTION_FEE}` : null,
    `Total — £${total.toFixed(0)}`,
    `Deposit today (25%) — £${deposit.toFixed(0)}`,
    `Remaining balance — £${remaining.toFixed(0)}`,
  ].filter(Boolean);

  return {
    total,
    deposit,
    remaining,
    miles: Math.round(miles * 10) / 10,
    distanceCharge: Math.round(distanceCharge),
    base,
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
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
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

  const distanceCharge = NEW_PER_MILE * miles;
  const pickupInLondon = isInLondonZones(lat1, lng1);
  const dropoffInLondon = isInLondonZones(lat2, lng2);
  const congestionApplied = pickupInLondon || dropoffInLondon;
  const congestionFee = congestionApplied ? NEW_CONGESTION_FEE : 0;

  let total = NEW_BASE_FEE + distanceCharge + congestionFee;
  total = Math.round(total);
  const deposit = Math.round(total * NEW_DEPOSIT_PERCENT);
  const remaining = total - deposit;

  const breakdown = [
    `Base fee — £${NEW_BASE_FEE}`,
    `Distance — £${distanceCharge.toFixed(2)} (${miles.toFixed(1)} miles @ £${NEW_PER_MILE}/mile)`,
    congestionApplied ? `Congestion charge (London) — £${NEW_CONGESTION_FEE}` : null,
    `Total — £${total}`,
    `Deposit (25%) — £${deposit}`,
    `Remaining balance — £${remaining}`,
  ].filter(Boolean);

  return {
    total,
    deposit,
    remaining,
    miles,
    distanceCharge: Math.round(distanceCharge * 100) / 100,
    baseFee: NEW_BASE_FEE,
    perMile: NEW_PER_MILE,
    congestionApplied,
    congestionFee: congestionApplied ? NEW_CONGESTION_FEE : 0,
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

    const pickup = cleanPostcode(body.pickup);
    const dropoff = cleanPostcode(body.dropoff);

    if (!pickup || !dropoff) {
      return res
        .status(400)
        .json({ error: "Pickup and delivery postcodes are required." });
    }
    if (!isValidPostcode(pickup) || !isValidPostcode(dropoff)) {
      return res
        .status(400)
        .json({ error: "Please enter valid UK postcodes for pickup and delivery." });
    }

    if (!body.serviceType || !["man_van", "house_removal"].includes(body.serviceType)) {
      return res
        .status(400)
        .json({ error: "Invalid service type. Please choose Man & Van or House Removal." });
    }

    if (body.serviceType === "house_removal" && !body.houseSize) {
      return res
        .status(400)
        .json({ error: "Please select a valid property size for house removal." });
    }

    if (!body.name || !body.phone) {
      return res
        .status(400)
        .json({ error: "Name and mobile number are required to book." });
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
          // Re-use existing Stripe session instead of creating duplicates
          return res.json({
            url: existingBooking.stripeSessionUrl,
            bookingRef: existingBooking.bookingRef,
          });
        }
      }
    }

    // Generate a fresh booking reference if one was not supplied or did not exist
    if (!bookingRef) {
      do {
        bookingRef = `CMI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      } while (allBookings.some((b) => b.bookingRef === bookingRef));
    }

    const pricing = await calculatePricing({
      pickup,
      dropoff,
      serviceType: body.serviceType,
      houseSize: body.houseSize,
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      dropoffLat: body.dropoffLat,
      dropoffLng: body.dropoffLng,
    });

    const amountPence = Math.round(pricing.deposit * 100);
    if (!amountPence || amountPence < MIN_DEPOSIT * 100) {
      return res.status(400).json({ error: "Invalid deposit amount." });
    }

    // Persist booking (total, deposit, remaining, etc.)
    upsertBooking({
      bookingRef,
      pickup,
      dropoff,
      serviceType: body.serviceType,
      houseSize: body.houseSize || "",
      stairsPickup: body.stairsPickup || "no",
      stairsDropoff: body.stairsDropoff || "no",
      date: body.date || "",
      timeWindow: body.timeWindow || "any",
      name: body.name,
      phone: body.phone,
      email: body.email || "",
      notes: body.notes || "",
      total: pricing.total,
      deposit: pricing.deposit,
      remaining: pricing.remaining,
      miles: pricing.miles,
      status: "pending_deposit",
    });

    const session = await stripe.checkout.sessions.create({
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
      metadata: {
        bookingRef,
      },
      success_url: `${BASE_URL}/success.html`,
      cancel_url: `${BASE_URL}/cancel.html`,
    });

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
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "Google Maps API key is not configured on the server." });
  }
  res.json({ apiKey });
});

// ------------------------------
// Start server
// ------------------------------

// Optional: warn if Google Maps key is missing (needed for new-form and distance)
if (!process.env.GOOGLE_MAPS_API_KEY) {
  console.warn("⚠️  GOOGLE_MAPS_API_KEY is not set. New pricing form and distance calculation will be limited.");
}

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   New pricing form: http://localhost:${PORT}/new-form`);
});

