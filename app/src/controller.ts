import { BODY_LINES, DICTATE_ROW, INBOX_PAGE, INNER_WIDTH, render, type Purpose, type Screen } from './screens';
import { messageLine, paginateLines } from './text';
import type { Chat, Contact, Display, GatewayApi, GatewayConfig, Incoming, Input, Message, Mic, Target } from './types';

export const TIMING = {
  inboxPollMs: 15_000,
  threadPollMs: 8_000,
  countdownSeconds: 5,
  sentHoldMs: 1_500,
  maxRecordSeconds: 30,
  minRecordSeconds: 0.6,
  watchMs: 8_000,
  notifyHoldMs: 10_000,
};
// Screens a new-message card may replace. Never interrupt dictation, confirmation or a send in progress.
const INTERRUPTIBLE = new Set<Screen['kind']>(['inbox', 'favorites', 'thread', 'reply', 'newMessage', 'error', 'notify']);
const THREAD_LIMIT = 25;

export interface ControllerDeps {
  api: GatewayApi | null; // null until the phone-side settings provide a token
  display: Display;
  mic: Mic;
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void; // returns cancel
  exit: () => void;
  startDemo?: () => void; // tap on the not-paired screen starts demo mode
  log: (msg: string) => void;
}

type RecordReturn = { purpose: Purpose; target?: Target; startedAt: number };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

export class Controller {
  private screen: Screen = { kind: 'loading', note: 'Starting…' };
  private config: GatewayConfig = { quickReplies: [], favorites: [], stt: [] };
  private messages: Message[] = [];
  private nav = 0; // bumps on every navigation; stale async results are dropped
  private timers: Array<() => void> = [];
  private recording: RecordReturn | null = null;
  private inboxOffset = 0; // remembered so Back from a thread returns to the same inbox page
  private lastSeenAt: number | null = null; // newest message timestamp already accounted for
  private stopWatch: (() => void) | null = null;
  private pending: { incoming: Incoming; more: number } | null = null;

  constructor(private deps: ControllerDeps) {}

  get current(): Screen {
    return this.screen;
  }

  setApi(api: GatewayApi | null): void {
    this.stopWatching();
    this.lastSeenAt = null; // new source: don't replay its history as notifications
    this.deps = { ...this.deps, api };
    void this.start();
  }

  async start(): Promise<void> {
    const api = this.deps.api;
    if (!api) {
      this.show({ kind: 'setup', note: 'Not connected to your Mac yet. Set it up from Bubbles for G2 on your phone, or tap to try the demo.' });
      return;
    }
    this.show({ kind: 'loading', note: 'Loading messages…' });
    try {
      this.config = await api.config();
    } catch (err) {
      this.deps.log(`config failed: ${errorMessage(err)}`);
    }
    await this.openInbox();
    this.startWatching();
  }

  handle(input: Input): void {
    if (input.kind === 'exit') return this.shutdown();
    if (input.kind === 'background') {
      this.stopWatching();
      return this.clearTimers();
    }
    if (input.kind === 'foreground') {
      this.startWatching();
      return void this.refresh();
    }
    const s = this.screen;
    switch (s.kind) {
      case 'setup':
        if (input.kind === 'back') return this.deps.exit();
        if (input.kind === 'click' && this.deps.startDemo) return this.deps.startDemo();
        return void this.start();
      case 'loading': case 'transcribing': case 'sending': case 'sent':
        return input.kind === 'back' && s.kind === 'loading' ? this.deps.exit() : undefined;
      case 'error': return this.onError(s, input);
      case 'inbox': return this.onInbox(s, input);
      case 'favorites': return this.onFavorites(s, input);
      case 'notify': return this.onNotify(s, input);
      case 'thread': return this.onThread(s, input);
      case 'reply': return this.onReply(s, input);
      case 'newMessage': return this.onNewMessage(s, input);
      case 'pickContact': return this.onPickContact(s, input);
      case 'recording': return this.onRecording(input);
      case 'confirm': return this.onConfirm(s, input);
      case 'countdown': return input.kind === 'back' ? this.cancelCountdown(s) : undefined;
      case 'sendError': return this.onSendError(s, input);
    }
  }

  shutdown(): void {
    this.stopWatching();
    this.clearTimers();
    if (this.recording) void this.deps.mic.stop();
    this.recording = null;
  }

  // ---- navigation helpers ----

  private show(screen: Screen): void {
    this.screen = screen;
    void this.deps.display.show(render(screen, this.deps.now()));
  }

  private navigate(screen: Screen): number {
    this.clearTimers();
    this.nav += 1;
    this.show(screen);
    return this.nav;
  }

  private clearTimers(): void {
    this.timers.forEach((cancel) => cancel());
    this.timers = [];
  }

  private every(ms: number, fn: () => void): void {
    const tick = (): void => {
      fn();
      this.timers.push(this.deps.schedule(tick, ms));
    };
    this.timers.push(this.deps.schedule(tick, ms));
  }

  private fail(message: string, retry: 'inbox' | 'thread'): void {
    this.navigate({ kind: 'error', message, retry });
  }

  private async refresh(): Promise<void> {
    if (this.screen.kind === 'inbox') await this.openInbox(true);
    else if (this.screen.kind === 'thread') await this.openThread(this.screen.chat, true);
  }

  // ---- inbox ----

  private async openInbox(silent = false, offset = this.inboxOffset): Promise<void> {
    const api = this.deps.api;
    if (!api) return void this.start();
    const token = silent && this.screen.kind === 'inbox' ? this.nav
      : this.navigate({ kind: 'loading', note: 'Loading messages…' });
    try {
      // Ask for one extra chat to learn whether a "More" row is needed.
      const page = await api.chats(INBOX_PAGE + 1, offset);
      if (token !== this.nav) return;
      this.inboxOffset = offset;
      const next: Screen = { kind: 'inbox', chats: page.slice(0, INBOX_PAGE), offset,
        hasMore: page.length > INBOX_PAGE };
      if (!silent || this.screen.kind !== 'inbox') {
        this.navigate(next);
      } else if (inboxChanged(this.screen, next)) {
        // Redrawing a list resets the glasses' highlight to the top (scroll position isn't reported to apps),
        // so background refreshes only redraw when conversations actually changed, not when "2m" becomes "3m".
        this.show(next);
      }
      if (this.timers.length === 0) this.every(TIMING.inboxPollMs, () => void this.openInbox(true));
    } catch (err) {
      if (token === this.nav && !silent) this.fail(errorMessage(err), 'inbox');
    }
  }

  private onInbox(s: Extract<Screen, { kind: 'inbox' }>, input: Input): void {
    if (input.kind === 'holdStart') return void this.openFavorites();
    if (input.kind === 'back') {
      if (s.offset > 0) return void this.openInbox(false, Math.max(0, s.offset - INBOX_PAGE));
      return this.deps.exit();
    }
    if (input.kind !== 'click') return;
    const fixedRows = 2; // New message, Favorites
    if (input.index === 0) {
      this.navigate({ kind: 'newMessage', favorites: this.config.favorites });
      return;
    }
    if (input.index === 1) return void this.openFavorites();
    if (s.hasMore && input.index === fixedRows + s.chats.length) {
      return void this.openInbox(false, s.offset + INBOX_PAGE);
    }
    const chat = s.chats[input.index - fixedRows];
    if (chat) void this.openThread(chat);
  }

  // ---- favorites ----

  private async openFavorites(): Promise<void> {
    const api = this.deps.api;
    if (!api) return;
    const token = this.navigate({ kind: 'loading', note: 'Loading favorites…' });
    try {
      const favorites = await api.favorites();
      if (token !== this.nav) return;
      this.config = { ...this.config, favorites };
      this.navigate({ kind: 'favorites', favorites });
    } catch (err) {
      if (token === this.nav) this.fail(errorMessage(err), 'inbox');
    }
  }

  private onFavorites(s: Extract<Screen, { kind: 'favorites' }>, input: Input): void {
    if (input.kind === 'back') return void this.openInbox();
    if (input.kind !== 'click') return;
    const fav = s.favorites[input.index];
    if (!fav) return;
    if (fav.chatGuid) {
      void this.openThread({ guid: fav.chatGuid, name: fav.name, isGroup: false, lastText: '', lastAt: fav.lastAt,
        fromMe: false, unread: false });
    } else {
      void this.startRecording('body', addressTarget(fav));
    }
  }

  // ---- new-message notifications ----

  private startWatching(): void {
    if (this.stopWatch || !this.deps.api) return;
    let cancelled = false;
    let cancelTimer: () => void = () => undefined;
    const tick = async (): Promise<void> => {
      await this.checkUpdates();
      if (!cancelled) cancelTimer = this.deps.schedule(() => void tick(), TIMING.watchMs);
    };
    this.stopWatch = () => {
      cancelled = true;
      cancelTimer();
    };
    void tick();
  }

  private stopWatching(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  private async checkUpdates(): Promise<void> {
    const api = this.deps.api;
    if (!api) return;
    try {
      const first = this.lastSeenAt === null;
      const res = await api.updates(this.lastSeenAt ?? 0);
      this.lastSeenAt = Math.max(this.lastSeenAt ?? 0, res.latest);
      if (!first && res.messages.length) {
        const newest = res.messages[res.messages.length - 1];
        this.pending = { incoming: newest, more: res.messages.length - 1 + (this.pending ? 1 : 0) };
      }
    } catch (err) {
      this.deps.log(`updates failed: ${errorMessage(err)}`);
    }
    this.flushPending();
  }

  private flushPending(): void {
    const p = this.pending;
    const s = this.screen;
    if (!p || !INTERRUPTIBLE.has(s.kind)) return;
    this.pending = null;
    if (s.kind === 'thread' && s.chat.guid === p.incoming.chatGuid) {
      void this.openThread(s.chat, true); // already looking at it: just refresh
      return;
    }
    const prev = s.kind === 'notify' ? s.prev : s;
    const token = this.navigate({ kind: 'notify', incoming: p.incoming, more: p.more, prev });
    this.timers.push(this.deps.schedule(() => {
      if (token === this.nav && this.screen.kind === 'notify') this.restore(prev);
    }, TIMING.notifyHoldMs));
  }

  private onNotify(s: Extract<Screen, { kind: 'notify' }>, input: Input): void {
    const chat = incomingChat(s.incoming);
    if (input.kind === 'click') return void this.openThread(chat);
    if (input.kind === 'holdStart') return void this.startRecording('body', chatTarget(chat));
    if (input.kind === 'back') return this.restore(s.prev);
  }

  /** Return to a screen that a notification covered, reloading live data where it matters. */
  private restore(prev: Screen): void {
    if (prev.kind === 'inbox') return void this.openInbox(false, prev.offset);
    if (prev.kind === 'thread') return void this.openThread(prev.chat);
    if (prev.kind === 'favorites') return void this.openFavorites();
    this.navigate(prev);
  }

  // ---- thread ----

  private paginate(messages: Message[]): string[] {
    const pages = paginateLines(messages.map(messageLine), INNER_WIDTH, BODY_LINES);
    return pages.length ? pages : ['(no messages yet)'];
  }

  private async openThread(chat: Chat, silent = false): Promise<void> {
    const api = this.deps.api;
    if (!api) return;
    const prev = this.screen.kind === 'thread' ? this.screen : null;
    const token = silent && prev ? this.nav : this.navigate({ kind: 'loading', note: `Opening ${chat.name}…` });
    try {
      const latest = await api.messages(chat.guid, THREAD_LIMIT);
      if (token !== this.nav) return;
      const known = silent && prev ? this.messages : [];
      this.messages = mergeMessages(known, latest);
      const pages = this.paginate(this.messages);
      const atNewest = !prev || prev.page >= prev.pages.length - 1;
      const page = atNewest ? pages.length - 1 : Math.min(prev.page, pages.length - 1);
      const oldest = this.messages[0]?.at ?? 0;
      const next: Screen = { kind: 'thread', chat, pages, page, oldest };
      if (silent && prev) this.show(next);
      else this.navigate(next);
      if (this.timers.length === 0) this.every(TIMING.threadPollMs, () => void this.openThread(chat, true));
    } catch (err) {
      if (token === this.nav && !silent) this.fail(errorMessage(err), 'inbox');
    }
  }

  private async loadOlder(s: Extract<Screen, { kind: 'thread' }>): Promise<void> {
    const api = this.deps.api;
    if (!api || !s.oldest) return;
    const token = this.nav;
    try {
      const older = await api.messages(s.chat.guid, THREAD_LIMIT, s.oldest);
      if (token !== this.nav || !older.length) return;
      const before = this.paginate(this.messages).length;
      this.messages = mergeMessages(older, this.messages);
      const pages = this.paginate(this.messages);
      const added = pages.length - before;
      this.show({ ...s, pages, page: Math.max(0, added - 1), oldest: this.messages[0]?.at ?? 0 });
    } catch (err) {
      this.deps.log(`older failed: ${errorMessage(err)}`);
    }
  }

  private onThread(s: Extract<Screen, { kind: 'thread' }>, input: Input): void {
    const target = chatTarget(s.chat);
    switch (input.kind) {
      case 'up':
        if (s.page > 0) this.show({ ...s, page: s.page - 1 });
        else void this.loadOlder(s);
        return;
      case 'down':
        if (s.page < s.pages.length - 1) this.show({ ...s, page: s.page + 1 });
        return;
      case 'click':
        this.navigate({ kind: 'reply', target, options: [DICTATE_ROW, ...this.config.quickReplies] });
        return;
      case 'holdStart':
        void this.startRecording('body', target);
        return;
      case 'back':
        void this.openInbox();
    }
  }

  // ---- reply / new message ----

  private onReply(s: Extract<Screen, { kind: 'reply' }>, input: Input): void {
    if (input.kind === 'back') return this.returnTo(s.target);
    if (input.kind === 'holdStart') return void this.startRecording('body', s.target);
    if (input.kind !== 'click') return;
    if (input.index === 0) return void this.startRecording('body', s.target);
    const text = s.options[input.index];
    if (text) this.startCountdown(s.target, text, 'reply');
  }

  private onNewMessage(s: Extract<Screen, { kind: 'newMessage' }>, input: Input): void {
    if (input.kind === 'back') return void this.openInbox();
    if (input.kind !== 'click') return;
    if (input.index === 0) return void this.startRecording('name');
    const fav = s.favorites[input.index - 1];
    if (fav) void this.startRecording('body', addressTarget(fav));
  }

  private onPickContact(s: Extract<Screen, { kind: 'pickContact' }>, input: Input): void {
    if (input.kind === 'back') {
      this.navigate({ kind: 'newMessage', favorites: this.config.favorites });
      return;
    }
    if (input.kind !== 'click') return;
    const contact = s.matches[input.index];
    if (contact) void this.startRecording('body', addressTarget(contact));
  }

  private returnTo(target: Target): void {
    if (target.kind === 'chat') {
      void this.openThread({ guid: target.chatGuid, name: target.name, isGroup: target.isGroup,
        lastText: '', lastAt: 0, fromMe: false, unread: false });
    } else {
      void this.openInbox();
    }
  }

  // ---- dictation ----

  private async startRecording(purpose: Purpose, target?: Target): Promise<void> {
    const token = this.navigate({ kind: 'recording', purpose, target, seconds: 0 });
    const ok = await this.deps.mic.start().catch(() => false);
    if (token !== this.nav) {
      if (ok) await this.deps.mic.stop();
      return;
    }
    if (!ok) return this.fail('Glasses microphone unavailable.', target?.kind === 'chat' ? 'thread' : 'inbox');
    this.recording = { purpose, target, startedAt: this.deps.now() };
    this.every(1000, () => {
      if (!this.recording || this.screen.kind !== 'recording') return;
      const seconds = Math.floor((this.deps.now() - this.recording.startedAt) / 1000);
      if (seconds >= TIMING.maxRecordSeconds) void this.finishRecording();
      else this.show({ ...this.screen, seconds });
    });
  }

  private onRecording(input: Input): void {
    if (input.kind === 'click' || input.kind === 'holdEnd') return void this.finishRecording();
    if (input.kind !== 'back') return;
    const rec = this.recording;
    this.recording = null;
    void this.deps.mic.stop();
    if (rec?.target) this.returnTo(rec.target);
    else this.navigate({ kind: 'newMessage', favorites: this.config.favorites });
  }

  private async finishRecording(): Promise<void> {
    const rec = this.recording;
    const api = this.deps.api;
    if (!rec || !api) return;
    this.recording = null;
    const token = this.navigate({ kind: 'transcribing', purpose: rec.purpose, target: rec.target });
    const wav = await this.deps.mic.stop();
    const seconds = (wav.length - 44) / 32000;
    if (seconds < TIMING.minRecordSeconds) return this.retryAfter('Too short. Hold longer while speaking.', rec);
    try {
      const text = (await api.transcribe(wav)).trim();
      if (token !== this.nav) return;
      if (!text) return this.retryAfter("Didn't catch that.", rec);
      if (rec.purpose === 'name') await this.lookupContact(text, token);
      else if (rec.target) this.navigate({ kind: 'confirm', target: rec.target, text });
    } catch (err) {
      if (token === this.nav) this.retryAfter(`Transcription failed: ${errorMessage(err)}`, rec);
    }
  }

  private retryAfter(message: string, rec: RecordReturn): void {
    this.navigate({ kind: 'error', message: `${message} Tap to try again.`,
      retry: rec.target?.kind === 'chat' ? 'thread' : 'inbox' });
    this.pendingRetry = rec;
  }

  private pendingRetry: RecordReturn | null = null;

  private async lookupContact(name: string, token: number): Promise<void> {
    const matches = await this.deps.api!.contacts(name);
    if (token !== this.nav) return;
    if (!matches.length) {
      this.retryAfter(`No contact matches "${name}".`, { purpose: 'name', startedAt: 0 });
      return;
    }
    this.navigate({ kind: 'pickContact', query: name, matches });
  }

  private onError(s: Extract<Screen, { kind: 'error' }>, input: Input): void {
    const retry = this.pendingRetry;
    this.pendingRetry = null;
    if (input.kind === 'click') {
      if (retry) return void this.startRecording(retry.purpose, retry.target);
      return void (s.retry === 'inbox' ? this.openInbox() : this.refresh());
    }
    if (input.kind === 'back') {
      if (retry?.target) return this.returnTo(retry.target);
      return void this.openInbox();
    }
    this.pendingRetry = retry;
  }

  private onConfirm(s: Extract<Screen, { kind: 'confirm' }>, input: Input): void {
    if (input.kind === 'click') return this.startCountdown(s.target, s.text, 'confirm');
    if (input.kind === 'holdStart') return void this.startRecording('body', s.target);
    if (input.kind === 'back') return this.returnTo(s.target);
  }

  // ---- sending ----

  private startCountdown(target: Target, text: string, from: 'confirm' | 'reply'): void {
    this.navigate({ kind: 'countdown', target, text, remaining: TIMING.countdownSeconds, from });
    this.every(1000, () => {
      const s = this.screen;
      if (s.kind !== 'countdown') return;
      if (s.remaining <= 1) void this.send(s.target, s.text);
      else this.show({ ...s, remaining: s.remaining - 1 });
    });
  }

  private cancelCountdown(s: Extract<Screen, { kind: 'countdown' }>): void {
    if (s.from === 'confirm') {
      this.navigate({ kind: 'confirm', target: s.target, text: s.text });
    } else {
      this.navigate({ kind: 'reply', target: s.target, options: [DICTATE_ROW, ...this.config.quickReplies] });
    }
  }

  private async send(target: Target, text: string): Promise<void> {
    const api = this.deps.api;
    if (!api) return;
    const token = this.navigate({ kind: 'sending', target, text });
    try {
      await api.send(target, text);
      if (token !== this.nav) return;
      this.navigate({ kind: 'sent', target });
      this.timers.push(this.deps.schedule(() => {
        if (token + 1 === this.nav) this.returnTo(target);
      }, TIMING.sentHoldMs));
    } catch (err) {
      if (token === this.nav) this.navigate({ kind: 'sendError', target, text, message: errorMessage(err) });
    }
  }

  private onSendError(s: Extract<Screen, { kind: 'sendError' }>, input: Input): void {
    if (input.kind === 'click') return this.startCountdown(s.target, s.text, 'confirm');
    if (input.kind === 'back') return this.returnTo(s.target);
  }
}

export function chatTarget(chat: Chat): Target {
  return { kind: 'chat', chatGuid: chat.guid, name: chat.name, isGroup: chat.isGroup };
}

/** True when a refreshed inbox differs in something the user cares about (ignores the passage of time). */
export function inboxChanged(prev: Extract<Screen, { kind: 'inbox' }>, next: Extract<Screen, { kind: 'inbox' }>): boolean {
  const sig = (s: Extract<Screen, { kind: 'inbox' }>): string => [s.offset, s.hasMore,
    ...s.chats.map((c) => `${c.guid}|${c.lastAt}|${c.unread}|${c.fromMe}|${c.lastText}|${c.name}`)].join('\n');
  return sig(prev) !== sig(next);
}

export function incomingChat(i: Incoming): Chat {
  return { guid: i.chatGuid, name: i.name, isGroup: i.isGroup, lastText: i.text, lastAt: i.at, fromMe: false, unread: true };
}

export function addressTarget(contact: Contact): Target {
  return { kind: 'address', address: contact.address, name: contact.name };
}

export function mergeMessages(a: readonly Message[], b: readonly Message[]): Message[] {
  const byGuid = new Map<string, Message>();
  for (const m of [...a, ...b]) byGuid.set(m.guid, m);
  return [...byGuid.values()].sort((x, y) => x.at - y.at);
}
