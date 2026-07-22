const FIELDS = ['gatewayUrl', 'endpointPath', 'secret'];
const DEFAULTS = { gatewayUrl: '', endpointPath: '/webhooks/tiktok', secret: '' };

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const f of FIELDS) document.getElementById(f).value = stored[f] ?? DEFAULTS[f];
}

document.getElementById('save').addEventListener('click', async () => {
  const values = {};
  for (const f of FIELDS) values[f] = document.getElementById(f).value.trim();
  if (!values.endpointPath) values.endpointPath = DEFAULTS.endpointPath;
  await chrome.storage.sync.set(values);
  const s = document.getElementById('status');
  s.textContent = '✓ Saved';
  setTimeout(() => (s.textContent = ''), 1500);
});

load();
