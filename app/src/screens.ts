import { capBytes, capChars, clampLines, fitWidth, relativeTime, sanitize } from './text';
import type { Chat, Contact, Favorite, Incoming, PageSpec, Target } from './types';

// Layout (576x288 canvas): header 40px, body 212px, footer 36px. 4px padding everywhere.
export const LAYOUT = {
  width: 576,
  pad: 4,
  header: { y: 0, h: 40 },
  body: { y: 40, h: 212 },
  footer: { y: 252, h: 36 },
} as const;
export const INNER_WIDTH = LAYOUT.width - 2 * LAYOUT.pad;
export const BODY_LINES = Math.floor((LAYOUT.body.h - 2 * LAYOUT.pad) / 27);
const ROW_WIDTH = INNER_WIDTH - 24; // list highlight border + item padding
export const NEW_MESSAGE_ROW = '+ New message';
export const FAVORITES_ROW = '> Favorites';
export const MORE_ROW = 'More...';
/** Chats per inbox page: 20 list rows minus New message, Favorites and More. */
export const INBOX_PAGE = 17;
export const DICTATE_ROW = '> Dictate reply';
export const SAY_NAME_ROW = '> Say a name';

export type Purpose = 'body' | 'name';

export type Screen =
  | { kind: 'setup'; note: string }
  | { kind: 'loading'; note: string }
  | { kind: 'error'; message: string; retry: 'inbox' | 'thread' }
  | { kind: 'inbox'; chats: Chat[]; offset: number; hasMore: boolean }
  | { kind: 'favorites'; favorites: Favorite[] }
  | { kind: 'notify'; incoming: Incoming; more: number; prev: Screen }
  | { kind: 'thread'; chat: Chat; pages: string[]; page: number; oldest: number }
  | { kind: 'reply'; target: Target; options: string[] }
  | { kind: 'newMessage'; favorites: Contact[] }
  | { kind: 'pickContact'; query: string; matches: Contact[] }
  | { kind: 'recording'; purpose: Purpose; target?: Target; seconds: number }
  | { kind: 'transcribing'; purpose: Purpose; target?: Target }
  | { kind: 'confirm'; target: Target; text: string }
  | { kind: 'countdown'; target: Target; text: string; remaining: number; from: 'confirm' | 'reply' }
  | { kind: 'sending'; target: Target; text: string }
  | { kind: 'sent'; target: Target }
  | { kind: 'sendError'; target: Target; text: string; message: string };

// Firmware limits (Even Hub glasses-ui reference): list rows ≤ 64 (treated as UTF-8 bytes, like the
// documented 32-byte menu limit), ≤ 20 rows; text ≤ 1000 chars on create/rebuild. One bad field fails the page.
export const LIMITS = { listItemBytes: 64, listItems: 20, textChars: 1000 } as const;

/** One list row: pixel-fit, ASCII ellipsis, byte-capped. */
export function listRow(row: string, maxBytes: number): string {
  return capBytes(fitWidth(sanitize(row), ROW_WIDTH).replace(/…/g, '...'), maxBytes);
}

const line = (s: string): string => capChars(fitWidth(s, INNER_WIDTH), LIMITS.textChars);

const text = (header: string, body: string, footer: string): PageSpec => ({
  kind: 'text',
  header: line(header),
  body: capChars(clampLines(body, INNER_WIDTH, BODY_LINES), LIMITS.textChars),
  footer: line(footer),
});

const list = (header: string, rows: string[], footer: string): PageSpec => ({
  kind: 'list',
  header: line(header),
  items: rows.slice(0, LIMITS.listItems).map((r) => listRow(r, LIMITS.listItemBytes)),
  footer: line(footer),
});

export function chatRow(chat: Chat, now: number): string {
  const mark = chat.unread ? '* ' : '  ';
  const preview = chat.fromMe ? `You: ${chat.lastText}` : chat.lastText;
  return `${mark}${chat.name}  ${relativeTime(chat.lastAt, now)}  ${sanitize(preview)}`;
}

function quoted(t: string): string {
  return `"${t}"`;
}

export function render(screen: Screen, now: number): PageSpec {
  switch (screen.kind) {
    case 'setup':
      return text('Bubbles for G2', screen.note, 'tap: try demo   double-tap: exit');
    case 'loading':
      return text('Bubbles for G2', screen.note, '');
    case 'error':
      return text('Problem', screen.message, 'tap: retry   double-tap: back');
    case 'inbox': {
      const unread = screen.chats.filter((c) => c.unread).length;
      const range = `${screen.offset + 1}-${screen.offset + screen.chats.length}`;
      const header = screen.offset > 0 ? `Messages   ${range}` : unread ? `Messages   ${unread} unread` : 'Messages';
      const rows = [NEW_MESSAGE_ROW, FAVORITES_ROW, ...screen.chats.map((c) => chatRow(c, now)),
        ...(screen.hasMore ? [MORE_ROW] : [])];
      const footer = screen.offset > 0 ? 'tap: open   double-tap: previous page'
        : 'tap: open   hold: favorites   double-tap: exit';
      return list(header, rows, footer);
    }
    case 'notify': {
      const { incoming, more } = screen;
      const extra = more > 0 ? `   +${more} more` : '';
      const body = incoming.isGroup && incoming.sender ? `${incoming.sender}: ${incoming.text}` : incoming.text;
      return text(`New: ${incoming.name}${extra}`, body, 'tap: open   hold: reply   double-tap: dismiss');
    }
    case 'favorites':
      return list('Favorites', screen.favorites.length ? screen.favorites.map((f) => f.name) : ['(none set)'],
        'tap: open   double-tap: back');
    case 'thread': {
      const total = screen.pages.length;
      const pos = total > 1 ? `  ${screen.page + 1}/${total}` : '';
      return text(`${screen.chat.name}${pos}`, screen.pages[screen.page] ?? '(no messages)',
        'tap: reply   hold: dictate   swipe: scroll');
    }
    case 'reply':
      return list(`Reply to ${screen.target.name}`, screen.options, 'tap: choose   double-tap: back');
    case 'newMessage':
      return list('New message', [SAY_NAME_ROW, ...screen.favorites.map((f) => f.name)],
        'tap: choose   double-tap: back');
    case 'pickContact':
      return list(`Matches for ${quoted(screen.query)}`, screen.matches.map((m) => m.name),
        'tap: choose   double-tap: back');
    case 'recording': {
      const what = screen.purpose === 'name' ? 'Say the name…' : `Speak your message to ${screen.target?.name ?? ''}…`;
      return text(`Listening  ${screen.seconds}s`, what, 'tap or release: done   double-tap: cancel');
    }
    case 'transcribing':
      return text('Transcribing…', screen.purpose === 'name' ? 'Finding contact…' : 'One moment…', '');
    case 'confirm':
      return text(`To ${screen.target.name}`, quoted(screen.text),
        'tap: send   hold: redo   double-tap: discard');
    case 'countdown':
      return text(`Sending to ${screen.target.name} in ${screen.remaining}…`, quoted(screen.text),
        'double-tap: CANCEL');
    case 'sending':
      return text(`Sending to ${screen.target.name}…`, quoted(screen.text), '');
    case 'sent':
      return text('Sent', `Delivered to Messages for ${screen.target.name}.`, '');
    case 'sendError':
      return text('Not sent', `${screen.message}\n${quoted(screen.text)}`, 'tap: retry   double-tap: discard');
  }
}
