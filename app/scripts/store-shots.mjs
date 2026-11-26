// Captures Even Hub store screenshots from the simulator using demo mode (fictional data only).
// Run: npm run dev & ; node node_modules/@evenrealities/evenhub-simulator/bin/index.js http://localhost:5173 --automation-port 9898 & ;
//      node scripts/store-shots.mjs ../store/screenshots
import { mkdirSync, writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:9898/api';
const out = process.argv[2] ?? '../store/screenshots';
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 60; i++) {
  try { if ((await (await fetch(`${B}/ping`)).text()).includes('pong')) break; } catch { /* starting */ }
  await sleep(1000);
}
for (let i = 0; i < 30; i++) {
  if ((await (await fetch(`${B}/console`)).text()).includes('Bridge initialized')) break;
  await sleep(1000);
}
await sleep(5000);

const shot = async (name) => {
  writeFileSync(`${out}/${name}.png`, Buffer.from(await (await fetch(`${B}/screenshot/glasses`)).arrayBuffer()));
  console.log('saved', name);
};
const input = async (action, wait = 1800) => {
  await fetch(`${B}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  await sleep(wait);
};

await shot('00-not-connected');
await input('click', 3000); // try the demo
const demoStart = Date.now();
await shot('01-inbox');
await input('long_press', 400);
await input('long_press_release', 2500);
await shot('02-favorites');
await input('click', 2500); // Jordan
await shot('03-thread');
await input('click');
await shot('04-reply');
await input('down');
await input('click', 1200);
await shot('05-send-countdown');
await input('double_click');
await input('double_click', 2500); // back to thread
await input('double_click', 2500); // inbox
// Demo incoming text arrives ~25 s after the demo starts; the watcher polls every 8 s.
await sleep(Math.max(0, 25_000 + 9_000 - (Date.now() - demoStart)));
await shot('06-new-message');
console.log((await (await fetch(`${B}/console`)).text()).slice(-1500));
