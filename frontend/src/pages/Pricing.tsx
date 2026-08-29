import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { BillingStatus } from "../types";

function productBuyable(product: BillingStatus["products"]["pro_monthly"] | undefined): boolean {
  return Boolean(product?.price_id_configured || product?.payment_link);
}

export default function Pricing() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [email, setEmail] = useState("");
  const [searchParams] = useSearchParams();
  const checkoutState = searchParams.get("checkout");

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setStatus(await api.getBillingStatus());
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Failed to load billing status.");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function startCheckout(product: "pro_monthly" | "hosted_setup") {
    setBusy(product);
    try {
      setError(null);
      const info = status?.products[product];
      // Prefer direct Payment Link when Checkout Price IDs aren't wired yet.
      if (info?.payment_link && !info.price_id_configured) {
        window.location.href = info.payment_link;
        return;
      }
      const session = await api.createCheckout(product, email || undefined);
      window.location.href = session.checkout_url;
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : "Checkout failed. Set Payment Links or Stripe Price IDs (docs/SELLER_KIT.md).",
      );
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    try {
      setError(null);
      const { portal_url } = await api.createBillingPortal();
      window.location.href = portal_url;
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "Could not open billing portal.");
      setBusy(null);
    }
  }

  async function activateLicense(e: FormEvent) {
    e.preventDefault();
    setBusy("license");
    try {
      setError(null);
      const next = await api.activateLicense(licenseKey.trim());
      setStatus(next);
      setLicenseKey("");
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : "License activation failed.");
    } finally {
      setBusy(null);
    }
  }

  const proActive = status?.plan === "pro" && status.active;
  const canBuyPro = productBuyable(status?.products.pro_monthly);
  const canBuySetup = productBuyable(status?.products.hosted_setup);

  return (
    <div className="page page-wide pricing-page">
      <p className="pricing-brand">JUSTTECH</p>
      <h1>Sell the automation. Keep discovery free.</h1>
      <p className="page-subtitle">
        Free forever: find, score, and track jobs and grants. Pro unlocks drafting and Playwright form-fill — the work that
        saves hours per application.
      </p>

      {checkoutState === "success" && (
        <p className="success-banner">
          Payment received. Pro unlocks when the Stripe webhook lands, or activate a license key below.
        </p>
      )}
      {checkoutState === "canceled" && <p className="error-text">Checkout canceled — no charge.</p>}
      {error && <p className="error-text">{error}</p>}

      <div className="pricing-grid">
        <section className="pricing-tier">
          <h2>Free</h2>
          <p className="pricing-amount">$0</p>
          <ul>
            <li>Opportunity ingestion &amp; scoring</li>
            <li>Dashboard pipeline</li>
            <li>Profiles &amp; tracking</li>
          </ul>
          <p className="muted">Always available on this install.</p>
        </section>

        <section className="pricing-tier pricing-tier-pro">
          <h2>Pro</h2>
          <p className="pricing-amount">{status?.products.pro_monthly.price_display ?? "$29/mo"}</p>
          <ul>
            <li>Resume / cover letter / grant drafts</li>
            <li>Browser form-fill (human approve before submit)</li>
            <li>Recurring revenue for you as the seller</li>
          </ul>
          <label className="pricing-email">
            Email for receipt (optional)
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <button
            type="button"
            className="primary-btn"
            disabled={busy !== null || !canBuyPro || proActive}
            onClick={() => startCheckout("pro_monthly")}
          >
            {busy === "pro_monthly" ? "Redirecting…" : proActive ? "Pro active" : "Upgrade — pay with Stripe"}
          </button>
          {proActive && status?.has_stripe_customer && (
            <button type="button" style={{ marginTop: 8 }} disabled={busy !== null} onClick={openPortal}>
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
          )}
          {!canBuyPro && (
            <p className="muted">
              Wire <code>STRIPE_PAYMENT_LINK_PRO</code> or Price IDs — see docs/SELLER_KIT.md (60-minute path).
            </p>
          )}
        </section>

        <section className="pricing-tier">
          <h2>Founding Hosted Setup</h2>
          <p className="pricing-amount">{status?.products.hosted_setup.price_display ?? "$499"}</p>
          <ul>
            <li>Done-for-you deploy on your VPS or Surface</li>
            <li>Includes 1 year of Pro on this install</li>
            <li>Best first cash offer while MRR grows</li>
          </ul>
          <button type="button" disabled={busy !== null || !canBuySetup} onClick={() => startCheckout("hosted_setup")}>
            {busy === "hosted_setup" ? "Redirecting…" : "Buy setup — $499"}
          </button>
          {!canBuySetup && (
            <p className="muted">
              Set <code>STRIPE_PAYMENT_LINK_HOSTED_SETUP</code> to take this payment immediately.
            </p>
          )}
        </section>
      </div>

      <section className="pricing-license">
        <h2>Already paid? Activate a license key</h2>
        <p className="muted">After a Payment Link sale, the seller emails you a JTPRO key — paste it here.</p>
        <form onSubmit={activateLicense} className="filter-bar">
          <input
            type="text"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="JTPRO...."
            style={{ minWidth: 280, flex: 1 }}
            required
          />
          <button type="submit" disabled={busy === "license" || !licenseKey.trim()}>
            {busy === "license" ? "Activating…" : "Activate"}
          </button>
        </form>
      </section>

      {status && (
        <p className="muted" style={{ marginTop: 24 }}>
          This install: plan <strong>{status.plan}</strong> ({status.status})
          {status.valid_until ? ` · valid until ${new Date(status.valid_until).toLocaleDateString()}` : ""}
          {status.pro_required ? " · Pro enforcement on" : " · Pro enforcement off (OSS / dev mode)"}
        </p>
      )}
    </div>
  );
}
