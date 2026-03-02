# New pricing form — run locally

This document describes how to run the project and use the **new pricing form** (replacement for the existing booking form).

## Prerequisites

- **Node.js** (v18 or later recommended; the server uses native `fetch` for Google APIs)
- **npm** (comes with Node)

## Environment variables

Create a `.env` file in the project root (same folder as `server.js`). The new form and `/api/price` need:

| Variable | Required for new form | Description |
|----------|------------------------|-------------|
| `GOOGLE_MAPS_API_KEY` | **Yes** | Google Cloud API key with **Maps JavaScript API** (Places, Autocomplete) and **Distance Matrix API** (or Routes API) enabled. Used for UK autocomplete and distance calculation. |
| `PORT` | No | Server port; default `4242`. |
| `STRIPE_SECRET_KEY` | No (for price form) | Needed only for checkout/deposit; not required to get an instant price. |
| `STRIPE_WEBHOOK_SECRET` | Yes (for payments) | Webhook signing secret. For local dev: use Stripe CLI `stripe listen --forward-to http://localhost:4242/webhook` and paste the printed secret. See [STRIPE-WEBHOOK.md](STRIPE-WEBHOOK.md). |
| `SMTP_HOST` | No | SMTP server; default `smtp.ionos.co.uk`. |
| `SMTP_PORT` | No | SMTP port; default `587`. |
| `SMTP_USER` | No | SMTP username (e.g. `info@collectmyitem.co.uk`). |
| `SMTP_PASS` | Yes (for emails) | SMTP password for sending admin/customer emails. |
| `ADMIN_EMAIL` | No | Admin notification recipient; defaults to `SMTP_USER`. |

If `GOOGLE_MAPS_API_KEY` is missing, the server starts but will log a warning and the new form will not be able to load the map or get a price. If `SMTP_PASS` is missing, emails will not be sent (webhook will log a warning).

## Install and run

```bash
# From the project root (where package.json and server.js are)
npm install
node server.js
```

Then open:

- **Home:** http://localhost:4242/
- **New pricing form:** http://localhost:4242/new-form

(If you set `PORT` in `.env`, use that port instead of `4242`.)

## New form behaviour

- **Pickup / Dropoff:** UK postcode or full address. Both use Google Places Autocomplete (UK only). If the user types a valid UK postcode and does *not* choose a suggestion, the app validates the postcode, geocodes it, and uses `"<POSTCODE>, UK"` as the formatted address.
- **Get instant price:** Sends `POST /api/price` with pickup/dropoff (formatted address, postcode, lat/lng, placeId), service type, items count, stairs, date, and time window. The response shows total, deposit (25%), remaining balance, and a breakdown (base £35, £1.50/mile, London congestion £18 if applicable).

## Switching to the new form

The existing booking form is unchanged. When you are ready to use the new form as the main flow, link or redirect users to `/new-form` (e.g. from your main “Get a price” or “Pricing” button).
