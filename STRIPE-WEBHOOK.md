# Stripe Webhook Setup

## Local development (Stripe CLI)

Stripe cannot reach `localhost` directly. Use **Stripe CLI** to forward webhooks to your local server:

```bash
stripe listen --forward-to http://localhost:4242/webhook
```

The CLI will print a **webhook signing secret** (e.g. `whsec_...`). Add it to your `.env`:

```
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Use this value for local testing. The same env variable is used in both development and production — swap it when you switch environments.

## Production (IONOS / public domain)

1. In Stripe Dashboard: **Developers → Webhooks → Add endpoint**
2. URL: `https://<your-domain>/webhook` (e.g. `https://collectmyitem.co.uk/webhook`)
3. Select event: `checkout.session.completed`
4. Copy the **Signing secret** and set it in your production `.env`:

   ```
   STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

5. Ensure your server has a valid public SSL certificate (HTTPS). Stripe will not send webhooks to `http://` or `localhost`.

6. **Stripe receipt emails**: In Stripe Dashboard → Settings → Customer emails, enable "Successful payments" if you want Stripe to send receipt emails. The app passes `customer_email` to Checkout when the customer provides a valid email, so Stripe can send receipts.

## Server health check

To verify the server is reachable:

```bash
curl http://localhost:4242/health
```

Returns `200 OK` with `{"ok":true}` when the server is running.
