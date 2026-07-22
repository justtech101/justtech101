# Chatwoot Unified Inbox — Discord · Twitch · Instagram · TikTok

A small gateway that pipes messages from **Discord, Twitch, Instagram, and
TikTok** into a self-hosted [Chatwoot](https://www.chatwoot.com/) so your team
works every conversation from one inbox. Each incoming message is auto-labelled
(`lead` / `support` / `complaint` / `spam` / `general`), gets a priority, and
triggers an escalation ping on refund / legal / chargeback keywords. Agent
replies sent from Chatwoot are routed back out to the original platform.

```
Discord  ─┐
Twitch   ─┤   (this gateway)                     ┌── auto-label
Instagram─┼─▶ connectors ─▶ classifier ─▶ Chatwoot API   ├── set priority
TikTok*  ─┘                                       └── escalate
                     ▲                                    │
                     └──────── Chatwoot webhook ◀─────────┘  (agent reply → platform)
```

## Reality check on the four platforms

This is the honest part — the platforms are **not** equally supported, because
their APIs aren't.

| Platform | Official DM API? | What this kit does | Effort |
|---|---|---|---|
| **Discord** | ✅ Yes | Full two-way: DMs + server channels via a bot. | Minutes. |
| **Twitch** | ⚠️ Chat only | Bridges **channel chat** (public). True DMs ("whispers") are heavily rate-limited by Twitch and intentionally hard to automate. | Minutes. |
| **Instagram** | ✅ Yes | Two-way via the Meta Graph API. Requires a Business account + **Meta app review** (days on Meta's side). | Days (Meta's review). |
| **TikTok** | ❌ **No public DM API** | TikTok exposes **no** supported way to read/send normal DMs. This kit does **not** scrape TikTok (that violates their ToS and gets accounts banned). It provides a signed **inbound webhook** so that *if* you have a legitimate TikTok Shop / Business Messaging partner or licensed bridge, those messages flow in. | Blocked unless you have partner access. |

**Bottom line:** Discord and Twitch chat work today. Instagram works once Meta
approves your app. TikTok is wired and ready but cannot function without a
messaging source TikTok doesn't give the general public. Don't let anyone tell
you otherwise — if a "TikTok DM API" is offered to you, it's an unofficial
scraper and a ban risk.

## What's in here

| File | Purpose |
|---|---|
| `src/server.js` | Express app; boots connectors, exposes webhooks. |
| `src/router.js` | Core logic: inbound → Chatwoot, outbound → platform. Injectable/testable. |
| `src/chatwoot.js` | Chatwoot Application API client. |
| `src/classifier.js` | Dependency-free rules engine. Tune the keyword lists here. |
| `src/connectors/*.js` | One adapter per platform. |
| `test/*.test.js` | Offline tests (`node --test`, no external deps). |
| `docker-compose.yml`, `Dockerfile` | One-command deploy of the gateway. |

## Quick start

### 0. Prerequisites
- Node 18+ (for `npm test` / local run) **or** Docker.
- A running self-hosted Chatwoot. The fastest path is Chatwoot's official
  [Docker setup](https://www.chatwoot.com/docs/self-hosted/deployment/docker).

### 1. Verify the classifier offline (no accounts needed)
```bash
cd chatwoot-inbox
npm install
npm test        # runs the classifier + router tests
```

### 2. Create the Chatwoot inboxes
In Chatwoot: **Inboxes → Add Inbox → API**. Create one for each platform you'll
use (Discord, Twitch, Instagram, TikTok). Note each inbox's numeric id — it's in
the URL when you open the inbox settings.

### 3. Configure
```bash
cp .env.example .env
# fill in CHATWOOT_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN,
# the CHATWOOT_INBOX_* ids, and whichever platform credentials you have.
```

### 4. Run
```bash
npm start
# or:
docker compose up -d --build
```

### 5. Point Chatwoot's webhook back at the gateway
In Chatwoot: **Settings → Integrations → Webhooks → Add** →
`https://your-gateway-host/webhooks/chatwoot`, subscribed to
**Message created**. This is how agent replies get delivered back to each
platform.

## Per-platform setup

### Discord
1. [Discord Developer Portal](https://discord.com/developers/applications) → New
   Application → **Bot** → copy the token into `DISCORD_BOT_TOKEN`.
2. Under **Privileged Gateway Intents**, enable **Message Content**.
3. Invite the bot to your server with the `bot` scope and "Read/Send Messages".
   DMs to the bot work automatically once users share a server with it.

### Twitch
1. Create a bot account, then generate an OAuth chat token
   (`oauth:...`) → `TWITCH_OAUTH_TOKEN`. Set `TWITCH_BOT_USERNAME`.
2. `TWITCH_CHANNELS=yourchannel` — the bot joins and mirrors chat. Replies from
   Chatwoot post back into that channel.

### Instagram
1. Meta account with an IG **professional** account linked to a Facebook Page.
2. Create a Meta app, add **Instagram** + **Messenger** products, request the
   `instagram_manage_messages` permission (this is what needs review).
3. Set the webhook callback to `https://your-gateway-host/webhooks/instagram`
   with verify token = `IG_VERIFY_TOKEN`, subscribe to `messages`.
4. Put the page access token in `IG_PAGE_ACCESS_TOKEN`.

> Chatwoot also has a **native** Instagram channel. If you don't need the custom
> classifier pipeline for IG, that may be simpler — this connector exists so IG
> shares the same routing/labelling as the other platforms.

### TikTok
There is no public API to read or send TikTok DMs. This connector only accepts
messages POSTed to `https://your-gateway-host/webhooks/tiktok` in the shape:
```json
{ "senderId": "abc", "senderName": "someuser", "text": "hi", "secret": "<TIKTOK_INBOUND_SECRET>" }
```
Wire that endpoint up **only** from a legitimate source (TikTok Shop / Business
Messaging partner, or a bridge you're licensed to use). Outbound replies are
POSTed to `TIKTOK_OUTBOUND_URL` if set; otherwise the agent's reply is rejected
loudly rather than silently dropped.

## Tuning the classifier
Everything lives in `src/classifier.js` — edit the keyword arrays (`RULES`,
`ESCALATION_TERMS`) and the `PRIORITY_BY_CATEGORY` map. Re-run `npm test` after
changes. No redeploy of anything else required.

## Production notes
- The conversation-threading map in `router.js` is **in-memory**. For a real
  deployment, persist it (Redis/Postgres) so a restart doesn't fork threads.
- Verify the Chatwoot webhook signature (`CHATWOOT_WEBHOOK_SECRET`) and the
  Meta `X-Hub-Signature-256` header before trusting payloads.
- Put the gateway behind HTTPS (Caddy/Nginx/Cloudflare) — Meta and Chatwoot
  webhooks require it.

## License
MIT.
