import type { Chat, Contact, Favorite, GatewayApi, GatewayConfig, Message, Target, Updates } from './types';

const TIMEOUT_MS = 15_000;
const STT_TIMEOUT_MS = 45_000;

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const FRIENDLY: Record<number, string> = {
  401: 'Gateway rejected the token. Re-enter it on your phone.',
  429: 'Sending too fast. Wait a minute.',
  502: 'iMac Messages bridge is offline.',
  503: 'Dictation engine is not running on the iMac.',
};

export function createGatewayApi(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): GatewayApi {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new GatewayError('Cannot reach the iMac. Is Tailscale on?');
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new GatewayError(FRIENDLY[resp.status] ?? `Gateway error ${resp.status}`, resp.status);
    }
    return (await resp.json()) as T;
  }

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    config: () => call<GatewayConfig>('/config'),
    chats: (limit, offset = 0) => call<Chat[]>(`/chats?limit=${limit}&offset=${offset}`),
    favorites: () => call<Favorite[]>('/favorites'),
    setFavorites: (items) => call<Favorite[]>('/favorites', { ...json({ items }), method: 'PUT' }),
    updates: (since) => call<Updates>(`/updates?since=${Math.max(0, Math.floor(since))}`),
    messages: (chatGuid, limit, before) => {
      const cursor = before ? `&before=${before}` : '';
      return call<Message[]>(`/chats/${encodeURIComponent(chatGuid)}/messages?limit=${limit}${cursor}`);
    },
    contacts: (query) => call<Contact[]>(`/contacts?q=${encodeURIComponent(query)}`),
    send: async (target: Target, text: string) => {
      const body = target.kind === 'chat' ? { chatGuid: target.chatGuid, text } : { address: target.address, text };
      await call<{ ok: boolean }>('/send', json(body));
    },
    transcribe: async (wav, lang = 'en') => {
      const res = await call<{ text: string }>(`/stt?lang=${encodeURIComponent(lang)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav as unknown as BodyInit,
      }, STT_TIMEOUT_MS);
      return res.text;
    },
  };
}

export async function checkHealth(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const resp = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`);
    const body = (await resp.json()) as { bb: boolean; stt: string[] };
    return `Gateway OK · Messages bridge ${body.bb ? 'up' : 'DOWN'} · STT ${body.stt.join(', ') || 'none'}`;
  } catch {
    return 'Cannot reach gateway (is Tailscale on?)';
  }
}
