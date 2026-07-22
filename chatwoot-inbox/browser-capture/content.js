// Content script — the only part that touches the page.
//
// It does NOTHING automatically: no polling, no background scraping. It acts
// only when you click the floating button or use the right-click menu. That
// human-in-the-loop design is deliberate — it keeps this as close to "copy
// what I'm looking at" as possible rather than bot-like automation.
//
// All UI lives in a shadow DOM so the platform's CSS can't fight it and its
// CSS can't leak out.

(() => {
  const HOST_ID = '__chatwoot_capture_host__';
  if (document.getElementById(HOST_ID)) return; // already injected

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: system-ui, sans-serif; }
      .btn {
        background:#1f93ff; color:#fff; border:none; border-radius:24px;
        padding:10px 16px; font-size:14px; font-weight:600; cursor:pointer;
        box-shadow:0 2px 10px rgba(0,0,0,.25);
      }
      .btn:hover { background:#1a7fe0; }
      .panel {
        display:none; width:320px; background:#fff; color:#111;
        border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.28);
        padding:14px; position:absolute; bottom:52px; right:0;
      }
      .panel.open { display:block; }
      label { display:block; font-size:12px; color:#555; margin:8px 0 3px; }
      input, textarea {
        width:100%; border:1px solid #ccc; border-radius:6px; padding:7px;
        font-size:13px;
      }
      textarea { min-height:70px; resize:vertical; }
      .row { display:flex; gap:8px; margin-top:10px; }
      .row .btn { flex:1; padding:8px; font-size:13px; }
      .cancel { background:#eee; color:#333; }
      .cancel:hover { background:#ddd; }
      .status { font-size:12px; margin-top:8px; min-height:16px; }
      .ok { color:#1a7f37; } .err { color:#cf222e; }
      .hint { font-size:11px; color:#888; margin-top:6px; }
    </style>
    <div class="panel" id="panel">
      <div style="font-weight:700;font-size:14px;margin-bottom:4px;">Capture to inbox</div>
      <label>From (handle / name)</label>
      <input id="sender" placeholder="e.g. @janedoe" />
      <label>Message</label>
      <textarea id="text" placeholder="Select the message text first, or paste it here"></textarea>
      <div class="row">
        <button class="btn cancel" id="cancel">Cancel</button>
        <button class="btn" id="send">Send to inbox</button>
      </div>
      <div class="status" id="status"></div>
      <div class="hint">Tip: highlight the message, then click — it fills in automatically.</div>
    </div>
    <button class="btn" id="toggle">⬆ Inbox</button>
  `;

  const panel = root.getElementById('panel');
  const senderEl = root.getElementById('sender');
  const textEl = root.getElementById('text');
  const statusEl = root.getElementById('status');

  // Best-effort guess at who the conversation is with. TikTok/Instagram change
  // their DOM often, so this is intentionally loose and user-editable.
  function guessSender() {
    const candidates = [
      'h1', 'h2',
      '[data-e2e="chat-title"]',
      'header a[href*="/@"]',
      'a[href*="/@"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const t = el?.textContent?.trim();
      if (t && t.length <= 60) return t;
    }
    return '';
  }

  function openPanel(prefillText) {
    const selection = (prefillText || window.getSelection()?.toString() || '').trim();
    if (selection) textEl.value = selection;
    if (!senderEl.value) senderEl.value = guessSender();
    statusEl.textContent = '';
    statusEl.className = 'status';
    panel.classList.add('open');
    textEl.focus();
  }

  function closePanel() {
    panel.classList.remove('open');
  }

  root.getElementById('toggle').addEventListener('click', () => {
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });
  root.getElementById('cancel').addEventListener('click', closePanel);

  root.getElementById('send').addEventListener('click', () => {
    const text = textEl.value.trim();
    const senderName = senderEl.value.trim();
    if (!text) {
      statusEl.textContent = 'Message is empty.';
      statusEl.className = 'status err';
      return;
    }
    statusEl.textContent = 'Sending…';
    statusEl.className = 'status';
    chrome.runtime.sendMessage(
      { type: 'capture', payload: { senderId: senderName, senderName, text } },
      (resp) => {
        if (resp?.ok) {
          statusEl.textContent = '✓ Sent to inbox';
          statusEl.className = 'status ok';
          textEl.value = '';
          setTimeout(closePanel, 900);
        } else {
          statusEl.textContent = resp?.error || 'Failed to send.';
          statusEl.className = 'status err';
        }
      },
    );
  });

  // Triggered by the right-click context menu in background.js.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'confirm-capture') openPanel(msg.selectionText);
  });
})();
