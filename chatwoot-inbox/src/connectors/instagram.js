// Instagram connector — official Instagram Messaging via the Meta Graph API.
//
// Requirements (all on Meta's side, and app review takes days):
//   - an Instagram professional (Business/Creator) account
//   - linked to a Facebook Page
//   - a Meta app with the instagram_manage_messages permission
//   - a webhook subscription pointing at  {PUBLIC_URL}/webhooks/instagram
//
// Note: Chatwoot ALSO has a native Instagram channel. If you don't need custom
// routing you may prefer that. This connector exists so Instagram lives in the
// same gateway/classifier pipeline as the other platforms.
//
// kind: 'webhook'

export function createInstagramConnector({
  pageAccessToken,
  verifyToken,
  graphVersion = 'v21.0',
  fetchImpl,
  logger = console,
}) {
  const doFetch = fetchImpl || fetch;

  // GET — Meta's subscription handshake.
  function verify(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === verifyToken) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }

  // POST — inbound message events. Calls emit() for each real user message.
  async function handleWebhook(req, res, emit) {
    res.sendStatus(200); // ack fast; Meta retries on non-200
    const body = req.body || {};
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        // Skip echoes (our own outbound), read receipts, story replies w/o text.
        if (!senderId || event.message?.is_echo || !text) continue;
        try {
          await emit({ senderId, senderName: `ig:${senderId}`, text, meta: {} });
        } catch (e) {
          logger.error('[instagram] emit failed:', e.message);
        }
      }
    }
  }

  // `to` is the Instagram-scoped user id (PSID).
  async function send({ to, text }) {
    if (!pageAccessToken) throw new Error('[instagram] no page access token');
    const url = `https://graph.facebook.com/${graphVersion}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: to }, message: { text } }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`[instagram] send failed ${res.status}: ${detail}`);
    }
  }

  return { name: 'instagram', kind: 'webhook', verify, handleWebhook, send };
}

export default { createInstagramConnector };
