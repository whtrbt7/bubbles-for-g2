// Demo mode: a fully local GatewayApi with fictional people, so the app can be tried (and reviewed) without a Mac.
// Nothing here touches the network; "sent" messages only appear in the demo thread.
import type { Chat, Contact, Favorite, GatewayApi, Incoming, Message, Target, Updates } from './types';

const MIN = 60_000;
export const DEMO_INCOMING_DELAY_MS = 25_000;
const DEMO_TRANSCRIPT = 'On my way, see you in ten minutes';

interface Thread { chat: Chat; messages: Message[] }

function seed(now: number): Thread[] {
  const t = (minsAgo: number) => now - minsAgo * MIN;
  const chat = (guid: string, name: string, isGroup = false): Chat =>
    ({ guid, name, isGroup, lastText: '', lastAt: 0, fromMe: false, unread: false });
  const msg = (guid: string, fromMe: boolean, sender: string, text: string, at: number): Message =>
    ({ guid, fromMe, sender: fromMe ? 'You' : sender, text, at });
  const threads: Thread[] = [
    { chat: chat('demo;-;welcome', 'Welcome to Bubbles'), messages: [
      msg('w1', false, 'Bubbles', 'This is demo data. Nothing you send leaves your phone.', t(1)),
      msg('w2', false, 'Bubbles', 'Connect your own Mac in the phone app to see your real messages.', t(1)),
    ] },
    { chat: chat('demo;-;jordan', 'Jordan Lee'), messages: [
      msg('j1', false, 'Jordan Lee', 'Are you still coming for dinner tonight?', t(48)),
      msg('j2', true, '', 'Yes! What time?', t(46)),
      msg('j3', false, 'Jordan Lee', '7:30. Can you pick up bread on the way?', t(3)),
    ] },
    { chat: chat('demo;-;casey', 'Casey Lee'), messages: [
      msg('c1', false, 'Casey Lee', 'Practice moved to Thursday', t(95)),
      msg('c2', true, '', 'Got it, thanks', t(90)),
    ] },
    { chat: chat('demo;+;family', 'Family', true), messages: [
      msg('f1', false, 'Morgan Diaz', 'Photos from the weekend [photo]', t(180)),
      msg('f2', false, 'Casey Lee', 'So good!', t(175)),
    ] },
    { chat: chat('demo;-;riley', 'Riley Park'), messages: [
      msg('r1', true, '', 'Lunch tomorrow?', t(26 * 60)),
      msg('r2', false, 'Riley Park', 'Sounds great, noon works', t(25 * 60)),
    ] },
    { chat: chat('demo;-;sms', '+1 555 0100'), messages: [
      msg('s1', false, '+1 555 0100', 'Your verification code is 482913', t(3 * 24 * 60)),
    ] },
  ];
  return threads.map((th) => withSummary(th, th.chat.guid === 'demo;-;jordan' || th.chat.guid === 'demo;-;welcome'));
}

function withSummary(th: Thread, unread = false): Thread {
  const last = th.messages[th.messages.length - 1];
  return { ...th, chat: { ...th.chat, lastText: last.text, lastAt: last.at, fromMe: last.fromMe, unread } };
}

export function createDemoApi(now: () => number = () => Date.now()): GatewayApi {
  const startedAt = now();
  let threads = seed(startedAt);
  let incomingDelivered = false;
  let counter = 0;
  let favoriteGuids = ['demo;-;jordan', 'demo;-;casey', 'demo;-;riley'];

  const byGuid = (guid: string) => threads.find((th) => th.chat.guid === guid);
  const sorted = () => [...threads].sort((a, b) => b.chat.lastAt - a.chat.lastAt);
  const favorites = (): Favorite[] => favoriteGuids.flatMap((g) => {
    const th = byGuid(g);
    return th ? [{ name: th.chat.name, address: g, chatGuid: g, lastAt: th.chat.lastAt }] : [];
  });
  const append = (guid: string, message: Message, unread: boolean) => {
    threads = threads.map((th) => th.chat.guid === guid ? withSummary({ ...th, messages: [...th.messages, message] }, unread) : th);
  };

  return {
    config: async () => ({ quickReplies: ['On my way', 'Running 10 min late', 'Yes', 'No', 'Thanks!'],
      favorites: favorites(), stt: ['demo'] }),
    chats: async (limit, offset = 0) => sorted().slice(offset, offset + limit).map((th) => th.chat),
    favorites: async () => favorites(),
    setFavorites: async (items: string[]) => {
      // Items are contact names (from contacts search); map them back to demo threads.
      favoriteGuids = items.flatMap((item) => {
        const th = threads.find((x) => x.chat.name === item || x.chat.guid === item);
        return th ? [th.chat.guid] : [];
      });
      return favorites();
    },
    messages: async (chatGuid, limit, before) => {
      const all = byGuid(chatGuid)?.messages ?? [];
      return (before ? all.filter((m) => m.at < before) : all).slice(-limit);
    },
    contacts: async (query: string): Promise<Contact[]> => {
      const q = query.toLowerCase().split(' ')[0];
      return threads.filter((th) => !th.chat.isGroup && th.chat.name.toLowerCase().includes(q))
        .map((th) => ({ name: th.chat.name, address: th.chat.guid }));
    },
    send: async (target: Target, text: string) => {
      const guid = target.kind === 'chat' ? target.chatGuid : target.address;
      if (!byGuid(guid)) throw new Error('Demo: unknown conversation');
      counter += 1;
      append(guid, { guid: `sent-${counter}`, fromMe: true, sender: 'You', text, at: now() }, false);
    },
    transcribe: async () => DEMO_TRANSCRIPT,
    updates: async (since: number): Promise<Updates> => {
      const messages: Incoming[] = [];
      if (!incomingDelivered && now() - startedAt >= DEMO_INCOMING_DELAY_MS) {
        incomingDelivered = true;
        const at = now();
        append('demo;-;jordan', { guid: 'j-new', fromMe: false, sender: 'Jordan Lee', text: 'Also grab some ice cream please!', at }, true);
        messages.push({ chatGuid: 'demo;-;jordan', name: 'Jordan Lee', isGroup: false, sender: 'Jordan Lee',
          text: 'Also grab some ice cream please!', at });
      }
      const latest = Math.max(since, ...threads.map((th) => th.chat.lastAt));
      return { messages: messages.filter((m) => m.at > since), latest };
    },
  };
}
