import { describe, expect, it, vi } from 'vitest';
import { createGatewayApi, GatewayError } from './api';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('createGatewayApi', () => {
  it('sends the bearer token and encodes chat guids', async () => {
    const f = fakeFetch(200, []);
    const api = createGatewayApi('https://gw.test/', 'tok', f as unknown as typeof fetch);
    await api.messages('iMessage;-;+17325551234', 20, 99);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://gw.test/chats/iMessage%3B-%3B%2B17325551234/messages?limit=20&before=99');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('sends chat vs address targets', async () => {
    const f = fakeFetch(200, { ok: true });
    const api = createGatewayApi('https://gw.test', 'tok', f as unknown as typeof fetch);
    await api.send({ kind: 'chat', chatGuid: 'g', name: 'Mom', isGroup: false }, 'hi');
    await api.send({ kind: 'address', address: '+1', name: 'Dave' }, 'yo');
    expect(JSON.parse(f.mock.calls[0][1]?.body as string)).toEqual({ chatGuid: 'g', text: 'hi' });
    expect(JSON.parse(f.mock.calls[1][1]?.body as string)).toEqual({ address: '+1', text: 'yo' });
  });

  it('maps HTTP errors to friendly messages', async () => {
    const api = createGatewayApi('https://gw.test', 'tok', fakeFetch(502, {}) as unknown as typeof fetch);
    await expect(api.chats(5)).rejects.toThrow('iMac Messages bridge is offline.');
  });

  it('reports network failures as a Tailscale hint', async () => {
    const f = vi.fn(async () => { throw new TypeError('Load failed'); });
    const api = createGatewayApi('https://gw.test', 'tok', f as unknown as typeof fetch);
    await expect(api.chats(5)).rejects.toBeInstanceOf(GatewayError);
    await expect(api.chats(5)).rejects.toThrow(/Tailscale/);
  });

  it('posts wav bytes for transcription', async () => {
    const f = fakeFetch(200, { text: 'on my way' });
    const api = createGatewayApi('https://gw.test', 'tok', f as unknown as typeof fetch);
    expect(await api.transcribe(new Uint8Array(44))).toBe('on my way');
    expect(f.mock.calls[0][0]).toBe('https://gw.test/stt?lang=en');
    expect((f.mock.calls[0][1]?.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
  });
});
