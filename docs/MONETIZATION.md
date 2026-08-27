# Monetizing JustTech

JustTech stays **local-first OSS** for discovery/scoring. You charge for the
high-leverage automation path: **drafting + Playwright form-fill**.

## Products

| SKU | Default price | What buyer gets |
|-----|---------------|-----------------|
| **JustTech Pro** | $29/mo | Unlock drafting + browser fill on their install |
| **Founding Hosted Setup** | $499 one-time | You deploy for them + 1 year Pro on that install |

Free forever: ingest, score, dashboard, profiles, tracking.

## Money flow (Stripe)

1. Create a [Stripe](https://dashboard.stripe.com) account and activate payments.
2. Create two Prices:
   - Recurring monthly → copy Price ID into `STRIPE_PRICE_PRO_MONTHLY`
   - One-time → copy Price ID into `STRIPE_PRICE_HOSTED_SETUP`
3. Set secrets in `.env` (see `.env.example`):
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET` (endpoint: `POST /api/billing/webhook`)
   - `JUSTTECH_REQUIRE_PRO=true` on any install you sell/host
   - `JUSTTECH_LICENSE_SIGNING_SECRET` + `JUSTTECH_BILLING_ADMIN_SECRET` for offline keys
4. Point Checkout success/cancel URLs at your UI (`BILLING_SUCCESS_URL` /
   `BILLING_CANCEL_URL`).
5. Customer opens **Pricing** in the app → **Upgrade with Stripe** → pays →
   webhook activates Pro on that install.

### Webhook events to enable

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

### Offline / Payment Link sales

If you sell via a Stripe Payment Link and email a key:

```bash
curl -X POST "$API/api/billing/mint-license" \
  -H 'Content-Type: application/json' \
  -d '{"admin_secret":"…","days_valid":365,"email":"buyer@example.com"}'
```

Buyer pastes the `JTPRO.…` key on **Pricing → Activate**.

## Schema

Run [`backend/migrations/002_entitlements.sql`](../backend/migrations/002_entitlements.sql)
on existing databases (fresh `docker compose` mounts already apply it).

## Go-to-market this week

1. Turn on Stripe test mode, buy your own Pro once end-to-end.
2. Post one offer: “I install JustTech on your laptop/VPS — $499 founding setup.”
3. Flip live mode; set `JUSTTECH_REQUIRE_PRO=true` on customer hosts.
4. Convert setup clients to $29/mo Pro before the bundled year ends.

Do not build multi-tenant SaaS yet — one DB per customer (or self-host + license)
matches the current architecture and ships revenue faster.
