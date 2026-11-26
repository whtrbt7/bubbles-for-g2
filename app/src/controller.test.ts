import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller, mergeMessages, TIMING } from './controller';
import { DICTATE_ROW } from './screens';
import type { Chat, Favorite, GatewayApi, Incoming, Input, Message, Mic, PageSpec } from './types';

const MOM: Chat = { guid: 'iMessage;-;+17325551234', name: 'Mom', isGroup: false, lastText: 'running late?',
  lastAt: 0, fromMe: false, unread: true };
const FAVS: Favorite[] = [
  { name: 'Jordan Lee', address: '+12015550101', chatGuid: 'iMessage;-;+12015550101', lastAt: 9 },
  { name: 'Riley Park', address: '+12015550202', chatGuid: null, lastAt: 0 },
];
const MSGS: Message[] = [
  { guid: 'm1', fromMe: false, sender: 'Mom', text: 'are you coming?', at: 1 },
  { guid: 'm2', fromMe: true, sender: 'You', text: 'yes', at: 2 },
];

class FakeClock {
  t = 1_000_000;
  private tasks: Array<{ at: number; fn: () => void; live: boolean }> = [];
  schedule = (fn: () => void, ms: number) => {
    const task = { at: this.t + ms, fn, live: true };
    this.tasks.push(task);
    return () => { task.live = false; };
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = this.tasks.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      due.live = false;
      due.fn();
      await flush();
    }
    this.t = end;
  }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(overrides: Partial<GatewayApi> = {}) {
  const pages: PageSpec[] = [];
  const api: GatewayApi = {
    config: vi.fn(async () => ({ quickReplies: ['On my way', 'Yes'], favorites: [{ name: 'Dave', address: '+15550001111', chatGuid: null, lastAt: 0 }], stt: ['parakeet'] })),
    chats: vi.fn(async () => [MOM]),
    favorites: vi.fn(async () => FAVS),
    setFavorites: vi.fn(async () => FAVS),
    updates: vi.fn(async (since: number) => ({ messages: [], latest: Math.max(since, 100) })),
    messages: vi.fn(async () => MSGS),
    contacts: vi.fn(async () => [{ name: 'Lisa Wong', address: '+17325559999' }]),
    send: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => 'on my way, ten minutes'),
    ...overrides,
  };
  const mic: Mic = {
    start: vi.fn(async () => true),
    stop: vi.fn(async () => new Uint8Array(44 + 32000 * 2)), // 2 s of audio
  };
  const clock = new FakeClock();
  const exit = vi.fn();
  const c = new Controller({
    api, mic, exit, now: () => clock.t, schedule: clock.schedule, log: () => undefined,
    display: { show: async (p) => { pages.push(p); } },
  });
  const press = async (input: Input) => { c.handle(input); await flush(); };
  return { c, api, mic, clock, exit, pages, press, last: () => pages[pages.length - 1] };
}

const tap = (index = 0): Input => ({ kind: 'click', index });
const OPEN_MOM = tap(2); // inbox rows: New message, Favorites, then chats
const back: Input = { kind: 'back' };

describe('Controller', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await h.c.start();
    await flush();
  });

  it('shows setup when no token is configured', async () => {
    const pages: PageSpec[] = [];
    const c = new Controller({ api: null, mic: h.mic, exit: vi.fn(), now: () => 0, schedule: h.clock.schedule,
      log: () => undefined, display: { show: async (p) => { pages.push(p); } } });
    await c.start();
    expect(c.current.kind).toBe('setup');
  });

  it('tap on the not-connected screen starts the demo; double-tap exits', async () => {
    const startDemo = vi.fn();
    const exit = vi.fn();
    const c = new Controller({ api: null, mic: h.mic, exit, now: () => 0, schedule: h.clock.schedule,
      log: () => undefined, display: { show: async () => undefined }, startDemo });
    await c.start();
    c.handle({ kind: 'click', index: 0 });
    expect(startDemo).toHaveBeenCalled();
    c.handle({ kind: 'back' });
    expect(exit).toHaveBeenCalled();
  });

  it('opens the inbox with a new-message row first', () => {
    const page = h.last();
    expect(h.c.current.kind).toBe('inbox');
    expect(page.kind).toBe('list');
    if (page.kind === 'list') {
      expect(page.items[0]).toBe('+ New message');
      expect(page.items[1]).toBe('> Favorites');
      expect(page.items[2]).toContain('Mom');
      expect(page.header).toContain('1 unread');
    }
  });

  it('double-tap on the inbox exits the app', async () => {
    await h.press(back);
    expect(h.exit).toHaveBeenCalled();
  });

  it('background refresh does not redraw (and reset the scroll position) when nothing changed', async () => {
    const before = h.pages.length;
    await h.clock.advance(TIMING.inboxPollMs * 4 + 10); // minutes pass: "2m" would become "3m"
    expect(h.api.chats).toHaveBeenCalledTimes(5);
    expect(h.pages.length).toBe(before);
  });

  it('background refresh redraws when a conversation changes', async () => {
    const before = h.pages.length;
    (h.api.chats as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...MOM, lastAt: 99, lastText: 'new!' }]);
    await h.clock.advance(TIMING.inboxPollMs + 10);
    expect(h.pages.length).toBe(before + 1);
    const page = h.last();
    expect(page.kind === 'list' && page.items[2]).toContain('new!');
  });

  it('polls the inbox periodically', async () => {
    await h.clock.advance(TIMING.inboxPollMs * 2 + 10);
    expect(h.api.chats).toHaveBeenCalledTimes(3);
  });

  it('opens a thread with newest messages on the last page', async () => {
    await h.press(OPEN_MOM);
    const s = h.c.current;
    expect(s.kind).toBe('thread');
    const page = h.last();
    expect(page.kind === 'text' && page.body).toContain('You: yes');
  });

  it('quick reply sends only after the 5 s countdown', async () => {
    await h.press(OPEN_MOM);
    await h.press(tap());
    expect(h.c.current.kind).toBe('reply');
    const page = h.last();
    expect(page.kind === 'list' && page.items[0]).toBe(DICTATE_ROW);
    await h.press(tap(1)); // "On my way"
    expect(h.c.current.kind).toBe('countdown');
    await h.clock.advance(4_000);
    expect(h.api.send).not.toHaveBeenCalled();
    await h.clock.advance(1_100);
    expect(h.api.send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat', chatGuid: MOM.guid }), 'On my way');
    expect(h.c.current.kind).toBe('sent');
    await h.clock.advance(TIMING.sentHoldMs + 10);
    expect(h.c.current.kind).toBe('thread');
  });

  it('double-tap during countdown cancels the send', async () => {
    await h.press(OPEN_MOM);
    await h.press(tap());
    await h.press(tap(2));
    await h.clock.advance(2_000);
    await h.press(back);
    expect(h.c.current.kind).toBe('reply');
    await h.clock.advance(10_000);
    expect(h.api.send).not.toHaveBeenCalled();
  });

  it('hold-to-dictate records, transcribes, and waits for confirmation', async () => {
    await h.press(OPEN_MOM);
    await h.press({ kind: 'holdStart' });
    expect(h.c.current.kind).toBe('recording');
    expect(h.mic.start).toHaveBeenCalled();
    await h.clock.advance(2_000);
    await h.press({ kind: 'holdEnd' });
    expect(h.mic.stop).toHaveBeenCalled();
    expect(h.c.current).toMatchObject({ kind: 'confirm', text: 'on my way, ten minutes' });
    expect(h.api.send).not.toHaveBeenCalled();
    await h.press(tap());
    await h.clock.advance(5_100);
    expect(h.api.send).toHaveBeenCalledWith(expect.objectContaining({ chatGuid: MOM.guid }), 'on my way, ten minutes');
  });

  it('discarding a transcript returns to the thread without sending', async () => {
    await h.press(OPEN_MOM);
    await h.press({ kind: 'holdStart' });
    await h.press({ kind: 'holdEnd' });
    await h.press(back);
    expect(h.c.current.kind).toBe('thread');
    expect(h.api.send).not.toHaveBeenCalled();
  });

  it('too-short recordings ask to try again', async () => {
    h.mic.stop = vi.fn(async () => new Uint8Array(44 + 1000));
    await h.press(OPEN_MOM);
    await h.press({ kind: 'holdStart' });
    await h.press({ kind: 'holdEnd' });
    expect(h.c.current.kind).toBe('error');
    expect(h.api.transcribe).not.toHaveBeenCalled();
    await h.press(tap());
    expect(h.c.current.kind).toBe('recording');
  });

  it('auto-stops recording at the max length', async () => {
    await h.press(OPEN_MOM);
    await h.press({ kind: 'holdStart' });
    await h.clock.advance((TIMING.maxRecordSeconds + 1) * 1000);
    expect(h.mic.stop).toHaveBeenCalled();
    expect(h.c.current.kind).toBe('confirm');
  });

  it('new message by spoken name: pick contact, dictate, confirm, send to address', async () => {
    h.api.transcribe = vi.fn().mockResolvedValueOnce('lisa').mockResolvedValueOnce('see you at 7');
    await h.press(tap(0));
    expect(h.c.current.kind).toBe('newMessage');
    await h.press(tap(0));
    await h.press(tap()); // stop recording name
    expect(h.api.contacts).toHaveBeenCalledWith('lisa');
    expect(h.c.current.kind).toBe('pickContact');
    await h.press(tap(0));
    expect(h.c.current).toMatchObject({ kind: 'recording', purpose: 'body' });
    await h.press(tap());
    expect(h.c.current).toMatchObject({ kind: 'confirm', text: 'see you at 7' });
    await h.press(tap());
    await h.clock.advance(5_100);
    expect(h.api.send).toHaveBeenCalledWith({ kind: 'address', address: '+17325559999', name: 'Lisa Wong' }, 'see you at 7');
    await h.clock.advance(TIMING.sentHoldMs + 10);
    expect(h.c.current.kind).toBe('inbox');
  });

  it('new message to a favorite skips name lookup', async () => {
    await h.press(tap(0));
    await h.press(tap(1));
    expect(h.c.current).toMatchObject({ kind: 'recording', target: { kind: 'address', name: 'Dave' } });
  });

  it('unknown spoken name shows an error and retries name capture', async () => {
    h.api.contacts = vi.fn(async () => []);
    await h.press(tap(0));
    await h.press(tap(0));
    await h.press(tap());
    expect(h.c.current.kind).toBe('error');
    await h.press(tap());
    expect(h.c.current).toMatchObject({ kind: 'recording', purpose: 'name' });
  });

  it('send failure keeps the text and offers retry', async () => {
    h.api.send = vi.fn().mockRejectedValueOnce(new Error('iMac Messages bridge is offline.')).mockResolvedValueOnce(undefined);
    await h.press(OPEN_MOM);
    await h.press(tap());
    await h.press(tap(1));
    await h.clock.advance(5_100);
    expect(h.c.current).toMatchObject({ kind: 'sendError', text: 'On my way' });
    await h.press(tap());
    await h.clock.advance(5_100);
    expect(h.api.send).toHaveBeenCalledTimes(2);
    expect(h.c.current.kind).toBe('sent');
  });

  it('gateway failure on load shows a retryable error', async () => {
    const f = setup({ chats: vi.fn().mockRejectedValueOnce(new Error('Cannot reach the iMac. Is Tailscale on?')).mockResolvedValue([MOM]) });
    await f.c.start();
    await flush();
    expect(f.c.current.kind).toBe('error');
    await f.press(tap());
    expect(f.c.current.kind).toBe('inbox');
  });

  it('mic failure surfaces an error instead of a silent recording screen', async () => {
    h.mic.start = vi.fn(async () => false);
    await h.press(OPEN_MOM);
    await h.press({ kind: 'holdStart' });
    expect(h.c.current.kind).toBe('error');
  });

  it('background pauses polling; foreground refreshes', async () => {
    await h.press({ kind: 'background' });
    await h.clock.advance(TIMING.inboxPollMs * 3);
    expect(h.api.chats).toHaveBeenCalledTimes(1);
    await h.press({ kind: 'foreground' });
    expect(h.api.chats).toHaveBeenCalledTimes(2);
  });

  it('scrolling up past the first page loads older messages', async () => {
    await h.press(OPEN_MOM);
    await h.press({ kind: 'up' });
    expect(h.api.messages).toHaveBeenLastCalledWith(MOM.guid, 25, 1);
  });
});

describe('Controller inbox paging and favorites', () => {
  const many = (n: number, from = 0): Chat[] => Array.from({ length: n }, (_, i) => ({
    ...MOM, guid: `iMessage;-;+1555000${String(from + i).padStart(4, '0')}`, name: `Person ${from + i}`,
    lastAt: 1000 - (from + i) }));

  it('shows More when another page exists and pages forward and back', async () => {
    const chats = vi.fn(async (limit: number, offset = 0) => many(Math.min(limit, 40 - offset), offset));
    const h = setup({ chats });
    await h.c.start(); await flush();
    const first = h.c.current;
    if (first.kind !== 'inbox') throw new Error('expected inbox');
    expect(first.chats).toHaveLength(17);
    expect(first.hasMore).toBe(true);
    expect(chats).toHaveBeenLastCalledWith(18, 0);
    const page = h.last();
    expect(page.kind === 'list' && page.items.at(-1)).toBe('More...');
    await h.press(tap(2 + 17)); // More row
    expect(chats).toHaveBeenLastCalledWith(18, 17);
    const second = h.c.current;
    expect(second.kind === 'inbox' && second.offset).toBe(17);
    expect(h.last().header).toContain('18-34');
    await h.press(tap(2)); // first chat on page 2
    expect(h.api.messages).toHaveBeenLastCalledWith('iMessage;-;+15550000017', 25);
    await h.press(back); // thread -> same inbox page
    expect(h.c.current).toMatchObject({ kind: 'inbox', offset: 17 });
    await h.press(back); // page 2 -> page 1, not exit
    expect(h.c.current).toMatchObject({ kind: 'inbox', offset: 0 });
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('no More row on the last page', async () => {
    const h = setup({ chats: vi.fn(async () => many(3)) });
    await h.c.start(); await flush();
    expect(h.c.current).toMatchObject({ kind: 'inbox', hasMore: false });
    const page = h.last();
    expect(page.kind === 'list' && page.items).toHaveLength(5);
  });

  it('hold on the inbox opens favorites sorted as the gateway returns them', async () => {
    const h = setup();
    await h.c.start(); await flush();
    await h.press({ kind: 'holdStart' });
    expect(h.c.current.kind).toBe('favorites');
    const page = h.last();
    expect(page.kind === 'list' && page.items).toEqual(['Jordan Lee', 'Riley Park']);
  });

  it('Favorites row opens favorites; a favorite with a chat opens that thread', async () => {
    const h = setup();
    await h.c.start(); await flush();
    await h.press(tap(1));
    await h.press(tap(0));
    expect(h.api.messages).toHaveBeenLastCalledWith('iMessage;-;+12015550101', 25);
    expect(h.c.current).toMatchObject({ kind: 'thread', chat: { name: 'Jordan Lee' } });
    await h.press(tap()); // reply menu works from a favorite's thread
    expect(h.c.current).toMatchObject({ kind: 'reply', target: { kind: 'chat', chatGuid: 'iMessage;-;+12015550101' } });
  });

  it('a favorite without a chat starts a new message to their address', async () => {
    const h = setup();
    await h.c.start(); await flush();
    await h.press(tap(1));
    await h.press(tap(1));
    expect(h.c.current).toMatchObject({ kind: 'recording', target: { kind: 'address', address: '+12015550202' } });
  });

  it('double-tap on favorites returns to the inbox', async () => {
    const h = setup();
    await h.c.start(); await flush();
    await h.press(tap(1));
    await h.press(back);
    expect(h.c.current.kind).toBe('inbox');
  });
});

describe('Controller new-message notifications', () => {
  const SAM: Incoming = { chatGuid: 'iMessage;-;+12015550101', name: 'Jordan Lee', isGroup: false,
    sender: 'Jordan Lee', text: 'picking up the kids?', at: 200 };
  // The gateway serves whatever is queued in `inbox` on the next poll.
  function withFeed() {
    let queued: Incoming[] = [];
    const updates = vi.fn(async (since: number) => {
      const out = queued.filter((m) => m.at > since);
      queued = [];
      return { messages: out, latest: Math.max(since, 100, ...out.map((m) => m.at)) };
    });
    const h = setup({ updates });
    return { ...h, push: (...m: Incoming[]) => { queued = [...queued, ...m]; } };
  }

  it('does not notify for messages that existed before the app opened', async () => {
    const h = withFeed();
    h.push({ ...SAM, at: 50 });
    await h.c.start(); await flush();
    await h.clock.advance(TIMING.watchMs * 2);
    expect(h.c.current.kind).toBe('inbox');
  });

  it('shows a card for a new text, tap opens the thread', async () => {
    const h = withFeed();
    await h.c.start(); await flush();
    h.push(SAM);
    await h.clock.advance(TIMING.watchMs + 10);
    expect(h.c.current).toMatchObject({ kind: 'notify', incoming: { name: 'Jordan Lee' } });
    const page = h.last();
    expect(page.header).toBe('New: Jordan Lee');
    expect(page.kind === 'text' && page.body).toContain('picking up the kids?');
    await h.press(tap());
    expect(h.c.current).toMatchObject({ kind: 'thread', chat: { guid: SAM.chatGuid } });
  });

  it('double-tap dismisses back to the inbox; the card also auto-dismisses', async () => {
    const h = withFeed();
    await h.c.start(); await flush();
    h.push(SAM);
    await h.clock.advance(TIMING.watchMs + 10);
    await h.press(back);
    expect(h.c.current.kind).toBe('inbox');
    expect(h.exit).not.toHaveBeenCalled();
    h.push({ ...SAM, at: 300 });
    await h.clock.advance(TIMING.watchMs + 10);
    expect(h.c.current.kind).toBe('notify');
    await h.clock.advance(TIMING.notifyHoldMs + 10);
    expect(h.c.current.kind).toBe('inbox');
  });

  it('hold on the card starts a dictated reply to that chat', async () => {
    const h = withFeed();
    await h.c.start(); await flush();
    h.push(SAM);
    await h.clock.advance(TIMING.watchMs + 10);
    await h.press({ kind: 'holdStart' });
    expect(h.c.current).toMatchObject({ kind: 'recording', target: { kind: 'chat', chatGuid: SAM.chatGuid } });
  });

  it('never interrupts a send countdown; shows the card afterwards', async () => {
    const h = withFeed();
    await h.c.start(); await flush();
    await h.press(OPEN_MOM);
    await h.press(tap());
    await h.clock.advance(6_000);
    await h.press(tap(1)); // quick reply -> 5 s countdown starting at t=6s
    h.push(SAM);
    await h.clock.advance(2_500); // watcher ticks at t=8s, mid-countdown
    expect(h.c.current.kind).toBe('countdown');
    expect(h.api.send).not.toHaveBeenCalled();
    await h.clock.advance(10_000); // send at 11s, back to thread at 12.5s, next tick at 16s
    expect(h.api.send).toHaveBeenCalledTimes(1);
    expect(h.c.current).toMatchObject({ kind: 'notify', incoming: { name: 'Jordan Lee' } });
  });

  it('a message for the thread you are reading refreshes it instead of interrupting', async () => {
    const h = withFeed();
    await h.c.start(); await flush();
    await h.press(OPEN_MOM);
    const calls = (h.api.messages as ReturnType<typeof vi.fn>).mock.calls.length;
    h.push({ ...SAM, chatGuid: MOM.guid, name: 'Mom' });
    await h.clock.advance(TIMING.watchMs + 10);
    expect(h.c.current.kind).toBe('thread');
    expect((h.api.messages as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls);
  });

  it('group messages show the sender and a count of extra messages', async () => {
    const h = withFeed();
    await h.c.start(); await flush();
    h.push({ ...SAM, at: 150 }, { ...SAM, chatGuid: 'iMessage;+;chat1', name: 'Family', isGroup: true, sender: 'Casey Lee', text: 'dinner?', at: 160 });
    await h.clock.advance(TIMING.watchMs + 10);
    const page = h.last();
    expect(page.header).toBe('New: Family   +1 more');
    expect(page.kind === 'text' && page.body).toContain('Casey Lee: dinner?');
  });

  it('stops polling in the background', async () => {
    const h = withFeed();
    await h.c.start(); await flush();
    await h.press({ kind: 'background' });
    const n = (h.api.updates as ReturnType<typeof vi.fn>).mock.calls.length;
    await h.clock.advance(TIMING.watchMs * 4);
    expect((h.api.updates as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n);
  });
});

describe('mergeMessages', () => {
  it('dedupes by guid and sorts oldest first', () => {
    const a = [{ ...MSGS[1] }];
    const b = [{ ...MSGS[0] }, { ...MSGS[1], text: 'edited' }];
    expect(mergeMessages(a, b).map((m) => m.text)).toEqual(['are you coming?', 'edited']);
  });
});
