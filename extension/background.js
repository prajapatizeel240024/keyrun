// Keeps the recording for one tab and hands it to the Keyrun control plane, which turns raw
// events into a draft workflow (same code path as `npm run record`).
const EMPTY = { recording: false, tabId: null, startUrl: null, events: [] };

async function load() {
  const { rec } = await chrome.storage.session.get('rec');
  return rec || { ...EMPTY };
}
async function save(rec) {
  await chrome.storage.session.set({ rec });
}

const keyrun = {
  async start(tabId, startUrl) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(startUrl || '')) throw new Error('Keyrun only records local apps (127.0.0.1).');
    const rec = { recording: true, tabId, startUrl, events: [] };
    await save(rec);
    return rec;
  },
  async stop() {
    const rec = await load();
    rec.recording = false;
    await save(rec);
    return rec;
  },
  async status() {
    return load();
  },
  async upload(server, token, app, kind) {
    const rec = await load();
    if (!rec.events.length) throw new Error('Nothing recorded yet.');
    const res = await fetch(server.replace(/\/$/, '') + '/api/admin/recordings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keyrun-admin': token },
      body: JSON.stringify({ events: rec.events, startUrl: rec.startUrl, app, kind }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  },
};
// Exposed for tests (Playwright evaluates in the service worker).
self.keyrun = keyrun;

// Serialize event appends so concurrent messages do not overwrite each other.
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'keyrun:event') {
    queue = queue.then(async () => {
      const rec = await load();
      if (rec.recording && sender.tab && sender.tab.id === rec.tabId) {
        rec.events.push(msg.evt);
        await save(rec);
      }
    });
    return false;
  }
  if (msg && msg.type === 'keyrun:call' && keyrun[msg.fn]) {
    queue
      .then(() => keyrun[msg.fn](...(msg.args || [])))
      .then((r) => sendResponse({ ok: true, result: r }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
