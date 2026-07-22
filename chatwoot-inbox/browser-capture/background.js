// Service worker. Holds the gateway config + shared secret (kept out of the
// page context) and does the actual POST to the gateway. The content script
// never sees the secret — it only asks the background to send.

const DEFAULTS = {
  gatewayUrl: '', // e.g. https://your-gateway-host
  endpointPath: '/webhooks/tiktok',
  secret: '',
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function sendToInbox({ senderId, senderName, text }) {
  const cfg = await getConfig();
  if (!cfg.gatewayUrl) {
    return { ok: false, error: 'Gateway URL not set. Open the extension options.' };
  }
  const url = cfg.gatewayUrl.replace(/\/+$/, '') + cfg.endpointPath;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderId: senderId || senderName,
        senderName: senderName || senderId,
        text,
        secret: cfg.secret,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `Gateway responded ${res.status}: ${detail}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Messages from the content script's confirm panel.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'capture') {
    sendToInbox(msg.payload).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  return false;
});

// Right-click a highlighted message -> "Send selection to Chatwoot inbox".
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'chatwoot-capture-selection',
    title: 'Send selection to Chatwoot inbox',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'chatwoot-capture-selection' || !tab?.id) return;
  // Hand off to the content script so the user can confirm sender + text.
  chrome.tabs.sendMessage(tab.id, {
    type: 'confirm-capture',
    selectionText: info.selectionText || '',
  });
});
