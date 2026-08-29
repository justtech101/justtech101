# Seller kit — first dollars from JustTech

Copy/paste assets for selling **Founding Hosted Setup ($499)** and **Pro ($29/mo)**.
Technical setup: [`MONETIZATION.md`](MONETIZATION.md).

## 60-minute path to first charge

1. Stripe account → activate payouts (bank) → turn **Live** mode when ready.
2. Products → create **JustTech Pro** ($29/mo) and **Founding Hosted Setup** ($499).
3. For each product: **Create payment link** → copy URLs into `.env`:
   - `STRIPE_PAYMENT_LINK_PRO=https://buy.stripe.com/...`
   - `STRIPE_PAYMENT_LINK_HOSTED_SETUP=https://buy.stripe.com/...`
4. Generate secrets once and store offline:
   ```bash
   openssl rand -hex 32   # JUSTTECH_LICENSE_SIGNING_SECRET
   openssl rand -hex 32   # JUSTTECH_BILLING_ADMIN_SECRET
   ```
5. Restart the app. Open **Pricing** — Upgrade / Buy setup buttons work via Payment Links.
6. After Stripe emails you a payment, mint a key:
   ```bash
   python3 scripts/mint_license.py --days 365 --email buyer@example.com
   ```
7. Send the buyer the key + “paste under Pricing → Activate.”

Payment Links alone are enough for cash this week. Add Checkout Price IDs + webhooks later for auto-unlock.

## Outreach — Founding Setup ($499)

**Subject:** I’ll install your job/grant application engine this week

```
Hey {Name},

I built JustTech — local software that finds jobs/grants, scores them,
drafts materials, and fills forms (you still hit submit).

Founding offer: I install and configure it on your laptop or a cheap VPS
for $499. Includes 1 year of Pro (drafting + browser fill).

If you’re drowning in applications, this pays for itself in a few evenings.

Reply “setup” and I’ll send a Stripe link + a 30-min kickoff slot.
— Just
```

**LinkedIn / X short:**

```
I’ll install a local job + grant application engine on your machine this week.
$499 founding setup (includes 1yr Pro). DM “setup”.
```

## Outreach — Pro ($29/mo)

**Subject:** Unlock drafting + form-fill on your JustTech install

```
Hey {Name},

You’re already using JustTech Free (discover → score → track).

Pro ($29/mo) unlocks:
• resume / cover letter / grant drafts from your verified profile
• Playwright form-fill with human approve before submit

Pay here: {STRIPE_PAYMENT_LINK_PRO}
Then paste the license key I email you under Pricing → Activate.
```

## Delivery checklist (after $499 payment)

- [ ] Spin up docker compose / their VPS
- [ ] Apply migrations (`001` + `002_entitlements`)
- [ ] Set `JUSTTECH_REQUIRE_PRO=true` + encryption key
- [ ] Enable RemoteOK (or their feeds)
- [ ] Create their applicant profile + min_salary
- [ ] Mint + activate Pro license (365 days)
- [ ] 30-min screen share: Qualified column → draft → dry-run fill
- [ ] Invoice/receipt from Stripe; ask for a testimonial

## Upsell timing

Day 300 of bundled Pro: email “renew Pro at $29/mo so drafting/fill stay unlocked.”
