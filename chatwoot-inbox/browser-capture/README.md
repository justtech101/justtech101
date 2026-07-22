# Chatwoot Inbox Capture (browser extension)

A **human-in-the-loop** browser extension for the platforms that have no message
API — chiefly **TikTok DMs**. You browse your messages normally; when you want a
message in your Chatwoot inbox, you click a button (or right-click the
highlighted text) and it's sent to the gateway's inbound webhook. From there it
flows through the same classifier/labelling pipeline as every other platform.

It is deliberately **capture-only and manual**. It does not log in for you, does
not poll in the background, and does not send replies back into TikTok.

## ⚠️ Read this before you install it

- **This is against TikTok's Terms of Service.** Their terms prohibit collecting
  information "using automated means," and an extension reading the page counts —
  even though you trigger it by hand. The realistic consequence is **your TikTok
  account**, not legal exposure (it's your own account reading your own incoming
  messages). But the ban risk is real. Use a business account you can afford to
  lose access to, and decide if that trade is worth it.
- **It's fragile.** It reads TikTok's HTML, which changes without notice. The
  sender-name guess in particular will need occasional updating — that's why
  every captured field is editable before you send.
- **One direction only.** It brings messages *in*. Reply inside TikTok itself.
  Auto-typing replies is what most makes automation look like a bot, so it's
  intentionally not here.
- If you have a legitimate TikTok Shop / Business Messaging partner, use that
  instead — it's supported and carries none of these risks.

If those trade-offs aren't acceptable, the zero-risk path is plain copy-paste
into a Chatwoot conversation.

## How it connects

```
You (browsing tiktok.com)
   │  click "⬆ Inbox" / right-click → Send selection
   ▼
extension  ──POST {senderId,senderName,text,secret}──▶  gateway /webhooks/tiktok
                                                              │
                                                              ▼
                                                 classifier → Chatwoot inbox
```

The extension is exactly the "legitimate inbound source" the gateway's TikTok
connector was built to accept. `/webhooks/tiktok` doubles as a generic
manual-capture sink, so you can point the extension at it from any API-less site.

## Setup

1. **Enable the TikTok webhook on the gateway.** In the gateway `.env`:
   ```
   TIKTOK_INBOUND_SECRET=pick-a-long-random-string
   CHATWOOT_INBOX_TIKTOK=<your TikTok API inbox id>
   ```
   Restart the gateway. Make sure it's reachable over **HTTPS** from your browser.

2. **Load the extension** (Chrome/Edge/Brave):
   - Go to `chrome://extensions`, turn on **Developer mode**.
   - **Load unpacked** → select this `browser-capture/` folder.

3. **Configure it.** Click the extension → **Details → Extension options** (or
   right-click the icon → Options):
   - **Gateway URL** — e.g. `https://your-gateway-host`
   - **Endpoint path** — leave as `/webhooks/tiktok`
   - **Shared secret** — the same `TIKTOK_INBOUND_SECRET` value

## Using it

1. Open your DMs on tiktok.com.
2. **Highlight** the message text you want to capture.
3. Either click the floating **⬆ Inbox** button (bottom-right) or right-click →
   **Send selection to Chatwoot inbox**.
4. Confirm the sender name and text in the little panel, click **Send to inbox**.

The message appears in your Chatwoot TikTok inbox, auto-labelled and prioritised.

## Notes

- The shared secret lives in the extension's background service worker and is
  attached to the request there — it is never exposed to the TikTok page.
- Sender attribution uses the handle/name you confirm as the threading key, so
  repeated captures from the same person land in one conversation.
- Selectors for the sender guess live in `content.js` (`guessSender()`) — adjust
  them there when TikTok changes its markup.
