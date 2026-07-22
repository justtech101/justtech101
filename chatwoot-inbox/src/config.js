// Central configuration, read from the environment.
//
// Every platform is optional: a connector only starts if its credentials are
// present. Each platform maps to its own Chatwoot "API" inbox so that agents
// can filter the unified inbox by source.

function num(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const config = {
  port: num(process.env.PORT) ?? 3000,

  chatwoot: {
    // e.g. https://chatwoot.yourdomain.com  (no trailing slash)
    url: (process.env.CHATWOOT_URL || '').replace(/\/+$/, ''),
    accountId: process.env.CHATWOOT_ACCOUNT_ID,
    // An "Access Token" from an agent/bot profile (Profile Settings > Access Token).
    apiToken: process.env.CHATWOOT_API_TOKEN,
    // Shared secret Chatwoot signs outgoing webhooks with (optional but recommended).
    webhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET,
  },

  // One Chatwoot "API" inbox id per platform. Create these in Chatwoot first
  // (Inboxes > Add Inbox > API), then paste the numeric ids here.
  inboxes: {
    discord: num(process.env.CHATWOOT_INBOX_DISCORD),
    twitch: num(process.env.CHATWOOT_INBOX_TWITCH),
    instagram: num(process.env.CHATWOOT_INBOX_INSTAGRAM),
    tiktok: num(process.env.CHATWOOT_INBOX_TIKTOK),
  },

  discord: {
    token: process.env.DISCORD_BOT_TOKEN,
  },

  twitch: {
    username: process.env.TWITCH_BOT_USERNAME,
    // OAuth token, format "oauth:xxxx" (https://twitchapps.com/tmi or the CLI).
    oauth: process.env.TWITCH_OAUTH_TOKEN,
    // Comma-separated list of channels the bot joins, e.g. "mychannel,otherchannel".
    channels: (process.env.TWITCH_CHANNELS || '')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  },

  instagram: {
    // Meta Graph API page access token with instagram_manage_messages.
    pageAccessToken: process.env.IG_PAGE_ACCESS_TOKEN,
    // Any string you choose; used to verify the Meta webhook subscription.
    verifyToken: process.env.IG_VERIFY_TOKEN,
    graphVersion: process.env.IG_GRAPH_VERSION || 'v21.0',
  },

  tiktok: {
    // TikTok has NO public DM API. This secret only guards the inbound webhook
    // used if you bridge messages in from a TikTok Shop / Business Messaging
    // partner or a third-party service. See src/connectors/tiktok.js.
    inboundSecret: process.env.TIKTOK_INBOUND_SECRET,
    // Optional URL a partner/bridge exposes for sending replies back out.
    outboundUrl: process.env.TIKTOK_OUTBOUND_URL,
    outboundToken: process.env.TIKTOK_OUTBOUND_TOKEN,
  },

  // Where escalations (refund / legal / chargeback) get pinged. Optional.
  escalation: {
    webhookUrl: process.env.ESCALATION_WEBHOOK_URL,
  },
};

// Reverse lookup: Chatwoot inbox id -> platform name (for routing outgoing replies).
config.inboxToPlatform = Object.fromEntries(
  Object.entries(config.inboxes)
    .filter(([, id]) => id !== undefined)
    .map(([platform, id]) => [String(id), platform]),
);

export default config;
