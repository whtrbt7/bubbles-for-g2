export interface PhoneSettings {
  url: string;
  token: string;
}

export interface PhoneUi {
  setStatus(text: string): void;
  log(text: string): void;
  setDemo(on: boolean): void;
}

const MAX_LOG_LINES = 30;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node as T;
}

/** Wires the phone-side settings form. Message content is never written to this log. */
export function mountPhoneUi(initial: PhoneSettings, onSave: (s: PhoneSettings) => Promise<void>,
  onDemo: () => Promise<void>): PhoneUi {
  const url = el<HTMLInputElement>('gw-url');
  const token = el<HTMLInputElement>('gw-token');
  const form = el<HTMLFormElement>('settings');
  const status = el<HTMLParagraphElement>('status');
  const logEl = el<HTMLPreElement>('log');
  const demoButton = el<HTMLButtonElement>('demo');
  const demoBanner = el<HTMLParagraphElement>('demo-banner');
  demoButton.addEventListener('click', () => void onDemo());
  url.value = initial.url;
  token.value = initial.token;
  token.placeholder = initial.token ? '•••••• saved' : 'paste token';

  const ui: PhoneUi = {
    setStatus: (text) => { status.textContent = text; },
    log: (text) => {
      if (import.meta.env.DEV) console.debug(`[g2msg] ${text}`); // simulator smoke visibility
      const stamp = new Date().toLocaleTimeString();
      const lines = [`${stamp} ${text}`, ...(logEl.textContent ?? '').split('\n')].slice(0, MAX_LOG_LINES);
      logEl.textContent = lines.join('\n');
    },
    setDemo: (on) => {
      demoBanner.hidden = !on;
      demoButton.hidden = on;
    },
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const next = { url: url.value.trim(), token: token.value.trim() };
    if (!/^https?:\/\//.test(next.url)) return ui.setStatus('Gateway URL must start with https://');
    if (next.token.length < 24) return ui.setStatus('Token looks too short.');
    ui.setStatus('Saving…');
    void onSave(next);
  });
  return ui;
}
