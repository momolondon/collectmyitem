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

// ✅ Stripe webhook MUST be raw and MUST come before express.json()
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

    console.log("✅ Payment confirmed for:", bookingRef);

    const bookings = fs.existsSync(BOOKINGS_FILE)
      ? JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8"))
      : [];

    const booking = bookings.find((b) => b.bookingRef === bookingRef);
    if (booking) {
      booking.status = "paid";
      booking.paidAt = new Date().toISOString();
      fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
    }
  }

  res.json({ received: true });
});

// ✅ normal middleware AFTER webhook
app.use(cors());
app.use(express.json());

// ✅ Serve your website files from /public (CSS/JS/images will work)
app.use(express.static(PUBLIC_DIR));

// ✅ Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Helper: save booking if not exists
function upsertBooking(data) {
  const bookings = fs.existsSync(BOOKINGS_FILE)
    ? JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8"))
    : [];

  let booking = bookings.find((b) => b.bookingRef === data.bookingRef);

  if (!booking) {
    booking = {
      ...data,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    bookings.push(booking);
  } else {
    Object.assign(booking, data);
  }

  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}


function calculatePriceServer(data) {

  const baseBySize = {
    small: 35,
    medium: 55,
    large: 75,
    xl: 95
  };

  const base = baseBySize[data.itemSize] || 55;

  let stairs = 0;

  if (data.stairsPickup === "yes") stairs += 10;
  if (data.stairsDropoff === "yes") stairs += 10;

  let congestion = 0;

  if (data.date && data.timeWindow) {

    const d = new Date(data.date);
    const day = d.getDay();

    if (day >= 1 && day <= 5) {

      if (
        data.timeWindow === "morning" ||
        data.timeWindow === "afternoon"
      ) congestion = 18;

    } else {

      if (data.timeWindow === "afternoon")
        congestion = 18;

    }

  }

  return base + stairs + congestion;
}

// ✅ Stripe Checkout (supports both /create-checkout-session and /api/create-checkout-session)

// ------------------------------
// Pricing helpers (SERVER-SIDE)
// ------------------------------
// ---------- Pricing helpers (SERVER) ----------
function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function timeWindowToRange(timeWindow) {
  switch (timeWindow) {
    case "morning": return [8 * 60, 12 * 60];
    case "afternoon": return [12 * 60, 17 * 60];
    case "evening": return [17 * 60, 21 * 60];
    case "any":
    default: return [0, 24 * 60];
  }
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function congestionChargeApplies(dateStr, timeWindow) {
  if (!dateStr) return false;
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const [winStart, winEnd] = timeWindowToRange(timeWindow || "any");

  // Mon–Fri 07:00–18:00
  if (day >= 1 && day <= 5) return rangesOverlap(winStart, winEnd, 7 * 60, 18 * 60);
  // Sat–Sun 12:00–18:00
  if (day === 0 || day === 6) return rangesOverlap(winStart, winEnd, 12 * 60, 18 * 60);

  return false;
}

function calculatePriceServer(body) {
  const baseBySize = { small: 35, medium: 55, large: 75, xl: 95 };
  const size = body.itemSize || "medium";
  const base = baseBySize[size] ?? 55;

  const count = clampNumber(body.itemCount, 1, 30, 1);
  const perExtraBySize = { small: 6, medium: 8, large: 10, xl: 12 };
  const perExtra = perExtraBySize[size] ?? 8;
  const extraItemsAdd = (count - 1) * perExtra;

  // Optional type add-ons if you still use itemType
  const itemType = body.itemType || "";
  const mixedAdd = itemType === "mixed" ? 10 : 0;
  const boxesAdd = itemType === "boxes" ? 5 : 0;
  const otherAdd = itemType === "other" ? 5 : 0;

  const stairsAdd =
    (body.stairsPickup === "yes" ? 10 : 0) +
    (body.stairsDropoff === "yes" ? 10 : 0);

  // Simple travel (keep your existing logic if you want)
  const zoneAdd = 15; // example fixed travel, or replace with your zone logic

  // ✅ Congestion: ONLY if user chose "yes" AND it applies by time/day
  const congestionAdd =
    body.congestionZone === "yes" && congestionChargeApplies(body.date, body.timeWindow)
      ? 18
      : 0;

  const total = Math.max(
    30,
    base + extraItemsAdd + mixedAdd + boxesAdd + otherAdd + stairsAdd + zoneAdd + congestionAdd
  );

  return Math.round(total / 5) * 5;
}

// ---------- Price endpoint (SERVER) ----------
app.post("/api/price", (req, res) => {
  try {
    const price = calculatePriceServer(req.body || {});
    res.json({ price });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Stripe checkout session (SERVER) ----------

async function handleCheckout(req, res) {

  try {

    const body = req.body || {};

    // ✅ Calculate price safely from body
    const calculatedTotal = calculatePriceServer(body);

    const amountPence = Math.round(calculatedTotal * 100);

    if (!amountPence || amountPence < 50) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const bookingRef =
      body.bookingRef ||
      `CMI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

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

    res.json({
      url: session.url,
      bookingRef,
    });

  }

  catch (err) {

    console.log("Stripe error:", err);

    res.status(500).json({
      error: err.message,
    });

  }

}

app.post("/create-checkout-session", handleCheckout);
app.post("/api/create-checkout-session", handleCheckout);

// ✅ yes, keep listen at the bottom
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});