export interface Chat {
  guid: string;
  name: string;
  isGroup: boolean;
  lastText: string;
  lastAt: number;
  fromMe: boolean;
  unread: boolean;
}

export interface Message {
  guid: string;
  fromMe: boolean;
  sender: string;
  text: string;
  at: number;
}

export interface Contact {
  name: string;
  address: string;
}

export interface Favorite extends Contact {
  chatGuid: string | null; // latest 1:1 chat with this person, if any
  lastAt: number;
}

export interface GatewayConfig {
  quickReplies: string[];
  favorites: Favorite[];
  stt: string[];
}

export interface Incoming {
  chatGuid: string;
  name: string; // chat name (person, or group title)
  isGroup: boolean;
  sender: string;
  text: string;
  at: number;
}

export interface Updates {
  messages: Incoming[]; // oldest first
  latest: number; // newest message timestamp the gateway has seen; use as the next `since`
}

/** Where an outgoing message goes: an existing chat, or a bare phone/email. */
export type Target =
  | { kind: 'chat'; chatGuid: string; name: string; isGroup: boolean }
  | { kind: 'address'; address: string; name: string };

export interface GatewayApi {
  config(): Promise<GatewayConfig>;
  chats(limit: number, offset?: number): Promise<Chat[]>;
  favorites(): Promise<Favorite[]>;
  updates(since: number): Promise<Updates>;
  messages(chatGuid: string, limit: number, before?: number): Promise<Message[]>;
  contacts(query: string): Promise<Contact[]>;
  send(target: Target, text: string): Promise<void>;
  transcribe(wav: Uint8Array, lang?: string): Promise<string>;
}

/** What one glasses page shows. The display adapter turns this into SDK containers. */
export type PageSpec =
  | { kind: 'list'; header: string; items: string[]; footer: string; selected?: number }
  | { kind: 'text'; header: string; body: string; footer: string };

export interface Display {
  show(page: PageSpec): Promise<void>;
}

export interface Mic {
  start(): Promise<boolean>;
  stop(): Promise<Uint8Array>; // returns a 16 kHz mono WAV
}

export type Input =
  | { kind: 'click'; index: number }
  | { kind: 'back' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'holdStart' }
  | { kind: 'holdEnd' }
  | { kind: 'foreground' }
  | { kind: 'background' }
  | { kind: 'exit' };
