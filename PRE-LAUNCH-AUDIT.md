# Collect My Item — Pre-launch website audit

Audit date: March 2025. This document summarises what’s working well and what should be fixed or added before launch.

---

## What’s good

### Core product & flow
- **Clear user journey**: Home → Quote (Step 1) → Details (Step 2) → Stripe → Success/Cancel. Step badges and CTAs are consistent.
- **Dual entry points**: Home links to `quote.html` (step flow); `new-form.html` offers a single-page “Get instant price” option. Both use the same backend pricing and checkout.
- **Pricing logic**: Server-side only; base fee, distance, congestion, helpers, stairs, bulky/box rules and minimum total are implemented and validated. Client cannot override prices.
- **Stripe integration**: Checkout session creation, metadata (`bookingRef`), success/cancel URLs, and webhook for `checkout.session.completed` are correctly set up. Webhook uses raw body and signature verification.
- **Post-payment**: Webhook marks booking as `paid_deposit`, sends admin and customer emails via Nodemailer. Duplicate payment is blocked (existing paid booking returns 400).

### Validation & data
- **UK postcodes**: Validated server-side with a proper regex; `cleanPostcode`/`isValidPostcode` used in pricing and checkout.
- **UK phone**: Server and client validate 07xxxxxxxxx / +447xxxxxxxxx.
- **Items**: Server resolves items from `body.items` or `body.itemsList` and does not trust client totals; bulky/box logic is server-side.
- **Idempotency**: Same `bookingRef` can reuse existing Stripe session URL when deposit not yet paid; avoids duplicate sessions.

### Admin
- **Admin panel**: Basic Auth on `/admin` and `/api/admin/*`; list bookings (paid only), view booking, mark done, mark driver paid. KPIs and filters are present.
- **Booking detail**: Shows ref, customer, addresses, amounts, notes, WhatsApp link; actions for job status and driver paid.

### Frontend quality
- **Accessibility**: Semantic HTML, `aria-label`, `aria-describedby`, `aria-live`/`role="alert"` on errors, labelled form fields. Step badges and structure are readable.
- **Responsive**: Viewport meta, responsive layout and media queries on key pages (home, quote, details, success, cancel, admin).
- **SEO**: Unique `<title>` and `<meta name="description">` on index, quote, new-form, details; `lang="en"` / `en-GB` set.
- **Branding**: Favicon, header logo, consistent “Collect My Item” and service-area messaging.

### Security (basics in place)
- **Secrets**: `.env` and `bookings.json` are gitignored.
- **Webhook**: Stripe signature verified; no reliance on client for payment confirmation.
- **Admin**: Credentials required; 401 with `WWW-Authenticate` when missing/wrong.

### Docs
- **README-NEW-FORM.md** and **STRIPE-WEBHOOK.md** describe run steps, env vars, and webhook setup.

---

## What’s missing or should be fixed

### Critical (fix before launch)

1. **Missing hero image**  
   - `public/css/styles.css` and `public/css/home.css` reference `url("../images/hero.jpg")`.  
   - **There is no `hero.jpg`** in `public/images/` (only `favicon.png`, `favebg.png`, `logo-collectmyitem-header.png`).  
   - **Fix**: Add `hero.jpg` (or another asset) and keep the path, or change the CSS to use an existing image (e.g. `favebg.png`) so the home background is not broken.

2. **No `.env.example`**  
   - `.gitignore` has `!.env.example` but the file is missing. New deployers don’t know which vars are required.  
   - **Fix**: Add `.env.example` with keys only (e.g. `PORT`, `BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GOOGLE_MAPS_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SMTP_*`, `ADMIN_EMAIL`).

3. **`package.json`**  
   - `"main": "index.js"` but the app is run with `node server.js`; there is no `index.js`.  
   - No `"start"` script (e.g. `"start": "node server.js"`).  
   - **Fix**: Set `"main": "server.js"` and add `"start": "node server.js"` (and optionally `"dev": "node server.js"` or use nodemon for local dev).

4. **Success page “Back to home” link**  
   - `success.html` uses `href="index.html"`. When the app is served from root, `href="/"` is more robust.  
   - **Fix**: Use `href="/"` for “Back to home” so it works regardless of how the server serves the home page.

### Important (strongly recommended)

5. **CORS**  
   - `app.use(cors())` with no options allows any origin.  
   - **Fix**: In production, use an allowlist: `cors({ origin: process.env.ALLOWED_ORIGIN || "https://yourdomain.com" })` (or an array of origins).

6. **Google Maps API key**  
   - Key is sent to the browser via `/api/maps-config`.  
   - **Fix**: In Google Cloud Console, restrict the key by HTTP referrer (and optionally by API: Maps JavaScript, Geocoding, Distance Matrix) so it can’t be abused from other sites.

7. **Rate limiting**  
   - No rate limiting on `/api/price`, `/create-checkout-session`, or `/api/create-checkout-session`.  
   - **Fix**: Add a rate limiter (e.g. `express-rate-limit`) for these routes to reduce abuse and scraping.

8. **Security headers**  
   - No Helmet (or similar) and no CSP.  
   - **Fix**: Add `helmet` and at least default security headers; tighten CSP if you have time.

9. **Stripe / env at startup**  
   - If `STRIPE_SECRET_KEY` is missing, the app only fails when the first Stripe call is made.  
   - **Fix**: Optionally check required env vars (e.g. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`) at startup and exit with a clear message if any are missing.

10. **HTTPS in production**  
    - Code does not enforce HTTPS.  
    - **Fix**: Run behind a reverse proxy (e.g. nginx, Cloudflare) that terminates HTTPS; set `BASE_URL` to `https://...` so Stripe success/cancel and any emails use HTTPS.

### Nice to have

11. **404 handling**  
    - Unknown routes get Express default (“Cannot GET /…”).  
    - **Fix**: Add a catch-all that serves a custom 404 page or `index.html` for SPA-style routing if you add client-side routes later.

12. **Cancel page flow**  
    - Cancel page links to `details.html` and `quote.html`. If the user came from the `new-form` flow, “Back to details” is still correct; “Start new quote” could go to `new-form.html` as well.  
    - Optional: detect or persist flow (quote vs new-form) and adjust links; or add a third link “Get new price” → `new-form.html`.

13. **Email HTML escaping**  
    - Webhook builds HTML with `${bookingRef}`, `${customerEmail}`, etc. Data is server-controlled, but escaping (e.g. replace `<`, `>`, `"`, `&`) would harden against any future injection.  
    - **Fix**: Use a simple escape function for any user- or booking-derived string inserted into HTML.

14. **Tests**  
    - `package.json` has `"test": "echo \"Error: no test specified\" && exit 1"`.  
    - **Fix**: Add a few critical tests (e.g. pricing helper, postcode validation, checkout validation) so refactors don’t break pricing or booking.

15. **Success page meta**  
    - `success.html` has no `<meta name="description">`.  
    - **Fix**: Add a short description for consistency and SEO.

16. **Single flow for “Get instant price”**  
    - Home has one CTA to `quote.html`; the other flow is `new-form.html`. If you want one primary flow, make the home CTA point to the chosen page and keep the other as an alternative (or remove the duplicate).

---

## Summary table

| Area           | Status | Notes                                              |
|----------------|--------|----------------------------------------------------|
| Booking flow   | Good   | Quote → Details → Stripe → Success/Cancel          |
| Pricing        | Good   | Server-side, validated, min total, no client trust |
| Stripe         | Good   | Session + webhook, signature verification           |
| Emails         | Good   | Admin + customer after payment                     |
| Admin          | Good   | Basic Auth, list/detail, mark done/driver paid      |
| Validation     | Good   | Postcode, phone, items server-side                 |
| Accessibility  | Good   | Labels, ARIA, structure                            |
| SEO            | Good   | Titles and descriptions on main pages              |
| Hero image     | Fix    | `hero.jpg` missing → broken home background        |
| .env.example   | Fix    | Missing → add for deployers                         |
| package.json   | Fix    | main/start script                                  |
| Success link   | Fix    | Prefer `/` for “Back to home”                       |
| CORS           | Improve| Restrict origin in production                       |
| Google key     | Improve| Restrict by referrer/API                            |
| Rate limiting  | Improve| On price + checkout                                |
| Security headers | Improve | Helmet / CSP                                     |
| 404 page       | Optional | Custom or SPA fallback                            |
| Tests          | Optional | At least pricing/validation                       |

---

## Recommended order of work

1. Add `hero.jpg` (or switch CSS to an existing image) and fix success “Back to home” to `/`.
2. Add `.env.example` and fix `package.json` (main + start script).
3. Restrict CORS and Google API key for production.
4. Add rate limiting and security headers (Helmet).
5. Optionally: 404 handler, email escaping, a few tests, and cancel-page link to `new-form.html`.

After these, the site is in good shape for launch from a correctness, security, and maintainability perspective.

---

## Go-live checklist: what’s automated vs what you do

### Checks done from the codebase (no server needed)

| Check | Result |
|-------|--------|
| All required env vars are used in code | ✅ `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `GOOGLE_MAPS_API_KEY`, `BASE_URL`, `PORT`; plus `SMTP_*` and `ADMIN_EMAIL` in `webhook.js` |
| `.env.example` lists required vars | ✅ Present with `PORT`, `BASE_URL`, Stripe, Google, Admin, SMTP, `ADMIN_EMAIL` |
| Stripe success/cancel URLs use `BASE_URL` | ✅ `success_url` and `cancel_url` use `${BASE_URL}/success.html` and `${BASE_URL}/cancel.html` |
| Webhook route exists and verifies signature | ✅ `/webhook` uses `express.raw`, checks `STRIPE_WEBHOOK_SECRET`, calls `stripe.webhooks.constructEvent` |
| Admin routes protected | ✅ `basicAuth` on `/admin` and `/api/admin`; 401 if credentials missing or wrong |
| No hardcoded production URLs | ✅ Only `localhost` is in console.log and in the default `BASE_URL` fallback; production uses env |
| Email sent after payment | ✅ `handleCheckoutSessionCompleted` in `webhook.js` sends admin + customer emails; requires `SMTP_PASS` |

### What you must do yourself (can’t be done from code)

1. **Set environment variables on the live server**  
   Copy from `.env.example` and fill in real values: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BASE_URL=https://yourdomain.com`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `GOOGLE_MAPS_API_KEY`, and SMTP vars (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `ADMIN_EMAIL`).

2. **Add the Stripe webhook for the live site**  
   In Stripe Dashboard → Developers → Webhooks → Add endpoint:  
   URL: `https://yourdomain.com/webhook`  
   Events: `checkout.session.completed`.  
   Copy the **Signing secret** (starts with `whsec_`) and set it as `STRIPE_WEBHOOK_SECRET` on the server.

3. **Test one payment after go-live**  
   You can use **Stripe test mode** (test keys + test card) on the live site so no real money is taken. After payment, confirm: booking appears in admin as paid, and you receive the admin notification email (and customer receives confirmation if they entered an email).

4. **Restrict Google Maps API key**  
   In Google Cloud Console, restrict the key by HTTP referrer to your domain and enable only the APIs you use (e.g. Maps JavaScript, Distance Matrix, Places if used).

5. **Use HTTPS**  
   Run the app behind a reverse proxy (or host) that provides HTTPS; keep `BASE_URL` as `https://...`.

---

### Payment and webhook: test after you’re live

- **Locally**, Stripe cannot reach your machine, so you don’t get real webhook delivery unless you use Stripe CLI (`stripe listen --forward-to localhost:4242/webhook`).
- **Once the site is live** at e.g. `https://collectmyitem.co.uk`, you add a webhook endpoint in Stripe pointing to `https://collectmyitem.co.uk/webhook`. Stripe will then send `checkout.session.completed` to that URL and your server will mark the booking paid and send the notification emails.

So you don’t need to go live *without* testing payment. Recommended flow:

1. Deploy the app and set all env vars (including `STRIPE_WEBHOOK_SECRET` for the **live** webhook).
2. In Stripe Dashboard, add the webhook to your **live** URL and set `STRIPE_WEBHOOK_SECRET`.
3. Do **one test payment** (Stripe test mode + test card on the live site).
4. Confirm in admin: booking shows as paid; you get the admin email; customer gets the confirmation email if they had an address.

After that, you can switch to live Stripe keys when you’re ready to take real payments.
