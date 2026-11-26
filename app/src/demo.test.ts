import { describe, expect, it } from 'vitest';
import { createDemoApi, DEMO_INCOMING_DELAY_MS } from './demo';

describe('demo api', () => {
  it('serves newest-first chats with paging and fictional names only', async () => {
    let t = 1_000_000_000_000;
    const api = createDemoApi(() => t);
    const chats = await api.chats(18, 0);
    expect(chats.length).toBeGreaterThanOrEqual(5);
    expect(chats.map((c) => c.lastAt)).toEqual([...chats.map((c) => c.lastAt)].sort((a, b) => b - a));
    expect(chats[0].name).toBe('Welcome to Bubbles');
    expect(await api.chats(18, 100)).toEqual([]);
    t += 1;
  });

  it('a send appears in the thread and nothing else happens', async () => {
    const t = 1_000_000_000_000;
    const api = createDemoApi(() => t);
    await api.send({ kind: 'chat', chatGuid: 'demo;-;casey', name: 'Casey Lee', isGroup: false }, 'See you there');
    const msgs = await api.messages('demo;-;casey', 25);
    expect(msgs.at(-1)).toMatchObject({ fromMe: true, text: 'See you there' });
    const chats = await api.chats(18);
    expect(chats[0].name).toBe('Casey Lee');
  });

  it('delivers one demo incoming message after a short delay', async () => {
    let t = 1_000_000_000_000;
    const api = createDemoApi(() => t);
    const first = await api.updates(0);
    expect(first.messages).toEqual([]);
    t += DEMO_INCOMING_DELAY_MS + 1;
    const second = await api.updates(first.latest);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ name: 'Jordan Lee' });
    expect((await api.updates(second.latest)).messages).toEqual([]);
  });

  it('favorites resolve to demo threads; dictation returns a sample sentence', async () => {
    const api = createDemoApi();
    const favs = await api.favorites();
    expect(favs.map((f) => f.name)).toEqual(['Jordan Lee', 'Casey Lee', 'Riley Park']);
    expect(favs.every((f) => f.chatGuid)).toBe(true);
    expect(await api.transcribe(new Uint8Array(44))).toMatch(/on my way/i);
    expect((await api.contacts('casey')).map((c) => c.name)).toEqual(['Casey Lee']);
  });
});
