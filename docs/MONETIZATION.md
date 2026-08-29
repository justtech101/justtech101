# Monetizing JustTech

JustTech stays **local-first OSS** for discovery/scoring. You charge for the
high-leverage automation path: **drafting + Playwright form-fill**.

**Seller copy + 60-minute cash path:** [`SELLER_KIT.md`](SELLER_KIT.md).

## Products

| SKU | Default price | What buyer gets |
|-----|---------------|-----------------|
| **JustTech Pro** | $29/mo | Unlock drafting + browser fill on their install |
| **Founding Hosted Setup** | $499 one-time | You deploy for them + 1 year Pro on that install |

Free forever: ingest, score, dashboard, profiles, tracking.

## Fastest money: Payment Links (no webhook required)

1. Create products in [Stripe](https://dashboard.stripe.com) → **Payment Links**.
2. Put URLs in `.env`:
   - `STRIPE_PAYMENT_LINK_PRO`
   - `STRIPE_PAYMENT_LINK_HOSTED_SETUP`
3. Set `JUSTTECH_LICENSE_SIGNING_SECRET` (and optionally admin secret).
4. Buyer pays via **Pricing** buttons → you mint a key:

```bash
python3 scripts/mint_license.py --days 365 --email buyer@example.com
```

5. Buyer pastes the key under **Pricing → Activate**.

## Full Checkout + auto-unlock (when you’re ready)

1. Create Price IDs → `STRIPE_PRICE_PRO_MONTHLY` / `STRIPE_PRICE_HOSTED_SETUP`
2. Set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
3. Webhook URL: `POST /api/billing/webhook`
4. Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
5. Set `JUSTTECH_REQUIRE_PRO=true` on sold/hosted installs
6. Subscribers manage billing via **Pricing → Manage billing** (Customer Portal)

## Schema

Run [`backend/migrations/002_entitlements.sql`](../backend/migrations/002_entitlements.sql)
on existing databases (fresh `docker compose` mounts already apply it).

## Architecture choice

Do not build multi-tenant SaaS yet — one DB per customer (or self-host + license)
matches the current stack and ships revenue faster.
