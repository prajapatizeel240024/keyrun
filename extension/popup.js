const $ = (id) => document.getElementById(id);
const call = (fn, ...args) =>
  chrome.runtime.sendMessage({ type: 'keyrun:call', fn, args }).then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.result;
  });

function show(text, cls) {
  $('status').className = cls || '';
  $('status').textContent = text;
}

async function refresh() {
  const rec = await call('status');
  if (rec.recording) show(`● Recording · ${rec.events.length} events`, 'rec');
  else if (rec.events.length) show(`Stopped · ${rec.events.length} events ready to send`);
  else show('Idle');
}

chrome.storage.local.get(['server', 'token', 'app', 'kind']).then((saved) => {
  for (const k of ['server', 'token', 'app', 'kind']) if (saved[k]) $(k).value = saved[k];
});
for (const k of ['server', 'token', 'app', 'kind']) $(k).addEventListener('change', () => chrome.storage.local.set({ [k]: $(k).value }));

$('start').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await call('start', tab.id, tab.url);
    refresh();
  } catch (e) {
    show(e.message);
  }
});
$('stop').addEventListener('click', async () => {
  await call('stop');
  refresh();
});
$('upload').addEventListener('click', async () => {
  try {
    const r = await call('upload', $('server').value, $('token').value, $('app').value, $('kind').value);
    show(`Saved as workflow #${r.id} (v${r.version}). Open ${$('server').value}/builder?id=${r.id}`);
  } catch (e) {
    show(e.message);
  }
});
refresh();
setInterval(refresh, 1000);
