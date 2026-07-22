// Entry point. Wires config -> Chatwoot client -> connectors -> router, then
// exposes the HTTP endpoints Chatwoot and the webhook platforms call.

import express from 'express';
import config from './config.js';
import { classify } from './classifier.js';
import { createChatwootClient } from './chatwoot.js';
import { createRouter } from './router.js';
import { createDiscordConnector } from './connectors/discord.js';
import { createTwitchConnector } from './connectors/twitch.js';
import { createInstagramConnector } from './connectors/instagram.js';
import { createTikTokConnector } from './connectors/tiktok.js';

async function escalationNotify({ reason, platform, senderName, text }) {
  const line = `🚨 Escalation (${reason}) on ${platform} from ${senderName}: ${text}`;
  console.warn(line);
  if (config.escalation.webhookUrl) {
    try {
      await fetch(config.escalation.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line }),
      });
    } catch (e) {
      console.error('[escalation] webhook failed:', e.message);
    }
  }
}

export function buildApp({ router, connectors }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Chatwoot -> here (agent replies go back out to platforms).
  app.post('/webhooks/chatwoot', async (req, res) => {
    try {
      const result = await router.handleChatwootWebhook(req.body);
      res.json(result);
    } catch (e) {
      console.error('[chatwoot webhook]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Instagram (Meta) webhook: GET verify + POST events.
  if (connectors.instagram) {
    app.get('/webhooks/instagram', (req, res) => connectors.instagram.verify(req, res));
    app.post('/webhooks/instagram', (req, res) =>
      connectors.instagram.handleWebhook(req, res, (msg) =>
        router.handleInbound({ platform: 'instagram', ...msg }),
      ),
    );
  }

  // TikTok inbound webhook (see connectors/tiktok.js for the big caveat).
  if (connectors.tiktok) {
    app.post('/webhooks/tiktok', (req, res) =>
      connectors.tiktok.handleWebhook(req, res, (msg) =>
        router.handleInbound({ platform: 'tiktok', ...msg }),
      ),
    );
  }

  return app;
}

async function main() {
  if (!config.chatwoot.url || !config.chatwoot.accountId || !config.chatwoot.apiToken) {
    console.error('Missing CHATWOOT_URL / CHATWOOT_ACCOUNT_ID / CHATWOOT_API_TOKEN. See .env.example.');
    process.exit(1);
  }

  const chatwoot = createChatwootClient(config.chatwoot);

  // Build only the connectors that are configured.
  const connectors = {};
  if (config.discord.token) {
    connectors.discord = createDiscordConnector(config.discord);
  }
  if (config.twitch.username && config.twitch.oauth && config.twitch.channels.length) {
    connectors.twitch = createTwitchConnector(config.twitch);
  }
  if (config.instagram.pageAccessToken) {
    connectors.instagram = createInstagramConnector(config.instagram);
  }
  // TikTok connector is available whenever an inbound secret is set.
  if (config.tiktok.inboundSecret || config.tiktok.outboundUrl) {
    connectors.tiktok = createTikTokConnector(config.tiktok);
  }

  const router = createRouter({
    chatwoot,
    classify,
    connectors,
    config,
    notify: escalationNotify,
  });

  // Start gateway-style connectors (they push messages to the router).
  for (const connector of Object.values(connectors)) {
    if (connector.kind === 'gateway') {
      connector.start((msg) =>
        router.handleInbound({ platform: connector.name, ...msg }),
      );
    }
  }

  const app = buildApp({ router, connectors });
  app.listen(config.port, () => {
    const active = Object.keys(connectors).join(', ') || 'none';
    console.log(`Chatwoot gateway listening on :${config.port} (connectors: ${active})`);
  });
}

// Only run the server when invoked directly (so tests can import buildApp).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export default { buildApp };
