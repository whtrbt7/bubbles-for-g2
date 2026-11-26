import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { checkHealth, createGatewayApi } from './api';
import { Controller } from './controller';
import { GlassesDisplay, GlassesMic } from './glasses';
import { isListSettleEcho, toInput } from './input';
import { mountPhoneUi, type PhoneSettings } from './phone-ui';

const DEFAULT_URL = ''; // each user enters their own Mac's gateway URL (printed by install.sh)
const KEY_URL = 'bubblesg2.url';
const KEY_TOKEN = 'bubblesg2.token';

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge();

  const stored: PhoneSettings = {
    url: (await bridge.getLocalStorage(KEY_URL)) || DEFAULT_URL,
    token: (await bridge.getLocalStorage(KEY_TOKEN)) || '',
  };
  // Dev-only convenience for the simulator; dead-code-eliminated from production builds.
  if (import.meta.env.DEV && import.meta.env.VITE_DEV_TOKEN) {
    stored.token = String(import.meta.env.VITE_DEV_TOKEN);
    stored.url = String(import.meta.env.VITE_DEV_URL || stored.url);
  }

  const apiFor = (s: PhoneSettings) => (s.token ? createGatewayApi(s.url, s.token) : null);

  const ui = mountPhoneUi(stored, async (next) => {
    await bridge.setLocalStorage(KEY_URL, next.url);
    await bridge.setLocalStorage(KEY_TOKEN, next.token);
    ui.setStatus(await checkHealth(next.url));
    controller.setApi(apiFor(next));
  });

  const mic = new GlassesMic(bridge);
  const display = new GlassesDisplay(bridge, ui.log);
  const controller = new Controller({
    api: apiFor(stored),
    display,
    mic,
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
    exit: () => void bridge.shutDownPageContainer(1),
    log: ui.log,
  });

  bridge.onEvenHubEvent((event) => {
    const pcm = event.audioEvent?.audioPcm;
    if (pcm) mic.push(pcm);
    if (display.listShownAt && isListSettleEcho(event, Date.now() - display.listShownAt)) {
      ui.log('ignored list settle echo');
      return;
    }
    const input = toInput(event);
    if (!input) return;
    ui.log(`input ${input.kind} on ${controller.current.kind}`);
    controller.handle(input);
  });
  window.addEventListener('beforeunload', () => controller.shutdown());

  ui.setStatus(stored.token ? await checkHealth(stored.url) : 'Paste the gateway token to pair.');
  await controller.start();
}

main().catch((err) => {
  const status = document.getElementById('status');
  if (status) status.textContent = `Startup failed: ${err instanceof Error ? err.message : String(err)}`;
});
