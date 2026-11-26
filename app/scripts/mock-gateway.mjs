// Fake msg-gw for simulator runs: no real messages on screen, and sends go nowhere.
// Usage: node scripts/mock-gateway.mjs  (listens on :8799, token "dev-token-dev-token-dev-token")
import { createServer } from 'node:http';

const TOKEN = 'dev-token-dev-token-dev-token';
const now = Date.now();
const min = 60_000;
const chats = [
  { guid: 'iMessage;-;+15550000001', name: 'Mom', isGroup: false, lastText: 'Are you still coming for dinner tonight?', lastAt: now - 2 * min, fromMe: false, unread: true },
  { guid: 'iMessage;-;+15550000002', name: 'Dave Park', isGroup: false, lastText: 'lol yes 😂', lastAt: now - 14 * min, fromMe: false, unread: true },
  { guid: 'iMessage;+;chat000000003', name: 'Lisa, Dave, Sam', isGroup: true, lastText: '[photo]', lastAt: now - 65 * min, fromMe: false, unread: false },
  { guid: 'SMS;-;+15550000004', name: '+15550000004', isGroup: false, lastText: 'Your verification code is 123456', lastAt: now - 3 * 60 * min, fromMe: false, unread: false },
  { guid: 'iMessage;-;+15550000005', name: 'Coach Rivera', isGroup: false, lastText: 'See you Saturday', lastAt: now - 3 * 24 * 60 * min, fromMe: true, unread: false },
];
const thread = Array.from({ length: 14 }, (_, i) => ({
  guid: `m${i}`,
  fromMe: i % 3 === 1,
  sender: i % 3 === 1 ? 'You' : 'Mom',
  text: i === 13 ? 'Are you still coming for dinner tonight?' : `Sample message ${i} about plans for the weekend and groceries`,
  at: now - (14 - i) * 5 * min,
}));
const sent = [];
let queued = []; // incoming messages injected via POST /mock/push (no auth; dev only)
let latest = Date.now();

const send = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST',
  });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return send(res, 200, { ok: true, bb: true, stt: ['mock'] });
  if (url.pathname === '/mock/push') {
    latest = Date.now();
    queued.push({ chatGuid: 'iMessage;-;+15550000002', name: 'Dave Park', isGroup: false, sender: 'Dave Park',
      text: 'Are we still on for lunch tomorrow at noon?', at: latest });
    return send(res, 200, { ok: true });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { detail: 'bad token' });
  if (url.pathname === '/config') return send(res, 200, { quickReplies: ['On my way', 'Running 10 min late', 'Yes', 'No'], favorites: [{ name: 'Mom', address: '+15550000001', chatGuid: 'iMessage;-;+15550000001', lastAt: now - 2 * min }], stt: ['mock'] });
  if (url.pathname === '/updates') {
    const since = Number(url.searchParams.get('since') || 0);
    const out = queued.filter((m) => m.at > since);
    queued = [];
    return send(res, 200, { messages: out, latest: Math.max(since, latest) });
  }
  if (url.pathname === '/chats') {
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 8);
    return send(res, 200, chats.slice(offset, offset + limit));
  }
  if (url.pathname === '/favorites') return send(res, 200, [
    { name: 'Mom', address: '+15550000001', chatGuid: 'iMessage;-;+15550000001', lastAt: now - 2 * min },
    { name: 'Coach Rivera', address: '+15550000005', chatGuid: 'iMessage;-;+15550000005', lastAt: now - 3 * 24 * 60 * min },
    { name: 'New Friend', address: '+15550000009', chatGuid: null, lastAt: 0 },
  ]);
  if (/^\/chats\/.+\/messages$/.test(url.pathname)) {
    const before = Number(url.searchParams.get('before') || 0);
    return send(res, 200, before ? [] : thread);
  }
  if (url.pathname === '/contacts') return send(res, 200, [{ name: 'Lisa Wong', address: '+15550000006' }]);
  if (url.pathname === '/stt') return send(res, 200, { text: 'on my way, ten minutes', engine: 'mock', ms: 5 });
  if (url.pathname === '/send') {
    let body = '';
    for await (const chunk of req) body += chunk;
    sent.push(JSON.parse(body));
    console.log('MOCK SEND', body);
    return send(res, 200, { ok: true, messageGuid: `mock-${sent.length}` });
  }
  return send(res, 404, {});
}).listen(8799, () => console.log('mock gateway on :8799'));
