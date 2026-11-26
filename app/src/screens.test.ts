import { describe, expect, it } from 'vitest';
import { LIMITS, render, type Screen } from './screens';
import type { Chat } from './types';

const now = Date.UTC(2026, 10, 25, 12);
const longChat = (i: number): Chat => ({
  guid: `iMessage;-;+1555000${String(i).padStart(4, '0')}`,
  // Narrow glyphs pack the most characters into the pixel budget: worst case for the char limit.
  name: `Iiiiiiiii Lllllllll ${i}`,
  isGroup: false,
  lastText: 'i l i l '.repeat(40) + 'long preview that keeps going and going',
  lastAt: now - i * 60_000,
  fromMe: i % 2 === 0,
  unread: i % 3 === 0,
});

describe('render respects firmware limits', () => {
  it("inbox rows stay within 64 UTF-8 bytes and 20 rows", () => {
    const page = render({ kind: 'inbox', chats: Array.from({ length: 30 }, (_, i) => longChat(i)), offset: 0, hasMore: true }, now);
    expect(page.kind).toBe('list');
    if (page.kind !== 'list') return;
    expect(page.items.length).toBeLessThanOrEqual(LIMITS.listItems);
    for (const item of page.items) expect(new TextEncoder().encode(item).length).toBeLessThanOrEqual(LIMITS.listItemBytes);
  });

  it('multi-byte names and smart punctuation stay within the byte budget', () => {
    const chat: Chat = { ...longChat(1), name: 'José Müller-Øster’s “Café” 東京', lastText: 'Ça va? ’’’ — ok… '.repeat(20) };
    const page = render({ kind: 'inbox', chats: [chat], offset: 0, hasMore: false }, now);
    if (page.kind !== 'list') throw new Error('expected list');
    for (const item of page.items) {
      expect(new TextEncoder().encode(item).length).toBeLessThanOrEqual(LIMITS.listItemBytes);
      expect(item).not.toContain('…');
    }
  });

  it('text bodies stay within 1000 chars', () => {
    const screen: Screen = { kind: 'confirm', target: { kind: 'address', address: '+1', name: 'X' },
      text: 'i '.repeat(3000) };
    const page = render(screen, now);
    expect(page.kind === 'text' && page.body.length).toBeLessThanOrEqual(LIMITS.textChars);
  });

  it('thread pages stay within 1000 chars', () => {
    const page = render({ kind: 'thread', chat: longChat(1), pages: ['i '.repeat(2000)], page: 0, oldest: 0 }, now);
    expect(page.kind === 'text' && page.body.length).toBeLessThanOrEqual(LIMITS.textChars);
  });
});
