// Drives the Even Hub simulator through the main flows and saves glasses screenshots.
// Needs: mock gateway (:8799), `npm run dev` with .env.development.local pointing at it, `npm run sim`.
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:9898/api';
const out = process.argv[2] ?? 'shots';
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 60; i++) {
  try { if ((await (await fetch(`${B}/ping`)).text()).includes('pong')) break; } catch { /* not up yet */ }
  await sleep(1000);
}
// Wait until the app has rendered its first page; inputs sent earlier get misrouted.
for (let i = 0; i < 30; i++) {
  const logs = await (await fetch(`${B}/console`)).text();
  if (logs.includes('createStartUpPageContainer') || logs.includes('rebuildPageContainer')) break;
  await sleep(1000);
}
await sleep(4000);

let n = 0;
const shot = async (name) => {
  const png = Buffer.from(await (await fetch(`${B}/screenshot/glasses`)).arrayBuffer());
  writeFileSync(`${out}/${String(++n).padStart(2, '0')}-${name}.png`, png);
};
const input = async (action, wait = 1500) => {
  await fetch(`${B}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  await sleep(wait);
};

await shot('inbox');
await input('long_press', 400);
await input('long_press_release', 2000);
await shot('favorites');
await input('double_click', 2500);
await shot('inbox-after-favorites');
await input('down');
await input('down');
await shot('inbox-row2');
await input('click', 2500);
await shot('thread');
await input('up');
await shot('thread-older');
await input('click');
await shot('reply-menu');
await input('down');
await input('click');
await shot('countdown');
await input('double_click');
await shot('countdown-cancelled');
await input('double_click', 2500);
await shot('back-to-thread');
await input('double_click', 2500);
await shot('back-to-inbox');
await input('up');
await input('up');
await input('up');
await input('click');
await shot('new-message');
await input('double_click', 2500);
await shot('inbox-again');
// New-message notification: inject a text into the mock, wait for the 8 s watcher, then tap to open it.
await fetch('http://127.0.0.1:8799/mock/push', { method: 'POST' });
await sleep(9500);
await shot('notify');
await input('click', 2500);
await shot('notify-opened-thread');
console.log((await (await fetch(`${B}/console`)).text()).slice(-2500));
