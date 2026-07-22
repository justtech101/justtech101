// TikTok connector — READ THIS BEFORE ASSUMING IT WORKS.
//
// TikTok does NOT provide a public API to read or send direct messages.
//   - The TikTok API for Developers / Content Posting API cannot access DMs.
//   - TikTok Business Messaging exists only for approved TikTok Shop sellers
//     and messaging partners (BSPs); it is not generally available.
//   - There is no supported way to poll or send a normal account's TikTok DMs.
//
// This connector therefore does NOT scrape TikTok or automate the app — doing
// so violates TikTok's Terms of Service and would get the account banned.
//
// What it DOES do: expose a signed inbound webhook so that IF you obtain a
// legitimate source of TikTok messages — a TikTok Shop / Business Messaging
// partner, or a third-party bridge you're licensed to use — those messages
// flow into Chatwoot through the same pipeline as every other platform.
// Outbound replies are POSTed to an optional partner URL you configure.
//
// Expected inbound POST body (JSON):
//   { "senderId": "abc123", "senderName": "someuser", "text": "hi", "secret": "..." }
//
// kind: 'webhook'

export function createTikTokConnector({
  inboundSecret,
  outboundUrl,
  outboundToken,
  fetchImpl,
  logger = console,
}) {
  const doFetch = fetchImpl || fetch;

  async function handleWebhook(req, res, emit) {
    const body = req.body || {};
    // Simple shared-secret check. Prefer a real HMAC signature in production.
    if (inboundSecret && body.secret !== inboundSecret) {
      res.sendStatus(403);
      return;
    }
    const { senderId, senderName, text } = body;
    if (!senderId || !text) {
      res.status(400).json({ error: 'senderId and text are required' });
      return;
    }
    res.sendStatus(200);
    try {
      await emit({ senderId, senderName: senderName || `tiktok:${senderId}`, text, meta: {} });
    } catch (e) {
      logger.error('[tiktok] emit failed:', e.message);
    }
  }

  async function send({ to, text }) {
    if (!outboundUrl) {
      // No supported channel to send on — surface it loudly rather than
      // silently dropping the agent's reply.
      throw new Error(
        '[tiktok] no TIKTOK_OUTBOUND_URL configured; TikTok has no public DM ' +
          'send API. Reply not delivered.',
      );
    }
    const res = await doFetch(outboundUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(outboundToken ? { Authorization: `Bearer ${outboundToken}` } : {}),
      },
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[tiktok] outbound send failed ${res.status}: ${detail}`);
    }
  }

  return { name: 'tiktok', kind: 'webhook', handleWebhook, send };
}

export default { createTikTokConnector };
