const nodemailer = require("nodemailer");
require("dotenv").config();

const SMTP_HOST = process.env.SMTP_HOST || "smtp.ionos.co.uk";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "info@collectmyitem.co.uk";
const SMTP_PASS = process.env.SMTP_PASS || "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "info@collectmyitem.co.uk";

function createTransporter() {
  if (!SMTP_PASS) {
    console.warn("⚠️ SMTP_PASS not set. Emails will not be sent.");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

/**
 * Format currency for display
 */
function formatPrice(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? `£${n.toFixed(2)}` : "—";
}

/**
 * Handle checkout.session.completed: send admin notification + customer confirmation
 */
async function handleCheckoutSessionCompleted(session, booking) {
  if (!booking) {
    console.warn("Webhook: No booking found for session, skipping emails.");
    return;
  }

  const bookingRef = booking.bookingRef || "—";
  const customerEmail =
    session?.customer_details?.email || session?.customer_email ||
    booking.customerEmail || booking.email || "";
  const customerPhone =
    session?.customer_details?.phone || booking.customerPhone || booking.phone || "";
  const pickup =
    booking.pickupAddress || booking.pickupFullAddress || booking.pickup || "—";
  const dropoff =
    booking.dropoffAddress || booking.dropoffFullAddress || booking.dropoff || "—";
  const notes = (booking.customerNote ?? booking.notes ?? "").trim();
  const totalPrice = formatPrice(booking.customerPrice ?? booking.total ?? 0);
  const depositPaid = formatPrice(booking.deposit ?? 0);
  const remainingBalance = formatPrice(
    booking.remainingBalance ?? booking.remaining ?? 0
  );

  const transporter = createTransporter();

  // 1. Admin email: New Paid Booking - CollectMyItem
  const adminHtml = `
    <h2>New Paid Booking - CollectMyItem</h2>
    <p>A customer has completed their deposit payment.</p>
    <table style="border-collapse: collapse;">
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Booking ref</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${bookingRef}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Customer email</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${customerEmail || "—"}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Customer phone</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${customerPhone || "—"}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Pickup</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${pickup}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Dropoff</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${dropoff}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Total price</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${totalPrice}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Deposit paid</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${depositPaid}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Remaining balance</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${remainingBalance}</td></tr>
      ${notes ? `<tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Customer note</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${notes}</td></tr>` : ""}
    </table>
  `;

  try {
    await transporter.sendMail({
      from: SMTP_USER,
      to: ADMIN_EMAIL,
      subject: "New Paid Booking - CollectMyItem",
      html: adminHtml,
    });
    console.log("[email sent] type=admin bookingRef=" + bookingRef);
  } catch (err) {
    console.error("[email failed] type=admin bookingRef=" + bookingRef + " error=" + err.message);
    console.error("sendMail error:", err);
  }

  // 2. Customer confirmation email
  if (!customerEmail || !customerEmail.trim()) {
    console.warn("[email skipped] type=customer bookingRef=" + bookingRef + " reason=no customer email");
    return;
  }

  const customerHtml = `
    <h2>Booking Confirmed – CollectMyItem</h2>
    <p>Hi${booking.customerName || booking.name ? ` ${booking.customerName || booking.name}` : ""},</p>
    <p>Your deposit has been paid successfully. Here are your booking details:</p>
    <table style="border-collapse: collapse;">
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Booking ref</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${bookingRef}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Pickup</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${pickup}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Dropoff</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${dropoff}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Total price</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${totalPrice}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Deposit paid</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${depositPaid}</td></tr>
      <tr><td style="padding: 6px 12px; border: 1px solid #ddd;"><strong>Remaining balance (pay driver on day)</strong></td><td style="padding: 6px 12px; border: 1px solid #ddd;">${remainingBalance}</td></tr>
    </table>
    <p>Pay the remaining balance directly to the driver on collection day.</p>
    <p>If you have any questions, please contact us at info@collectmyitem.co.uk.</p>
    <p>Thank you for choosing CollectMyItem!</p>
  `;

  try {
    await transporter.sendMail({
      from: SMTP_USER,
      to: customerEmail,
      subject: "Booking Confirmed – CollectMyItem",
      html: customerHtml,
    });
    console.log("[email sent] type=customer bookingRef=" + bookingRef);
  } catch (err) {
    console.error("[email failed] type=customer bookingRef=" + bookingRef + " error=" + err.message);
    console.error("sendMail error:", err);
  }
}

module.exports = { handleCheckoutSessionCompleted };
