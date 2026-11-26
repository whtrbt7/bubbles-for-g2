import {
  AudioInputSource,
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import { LAYOUT } from './screens';
import type { Display, Mic, PageSpec } from './types';
import { capBytes, toAscii, utf8Bytes } from './text';
import { pcmToWav } from './wav';

const IDS = { header: 1, list: 2, body: 3, footer: 4 } as const;
const NAMES = { header: 'header', list: 'main-list', body: 'main-body', footer: 'footer' } as const;

function textBox(id: number, name: string, y: number, h: number, content: string, capture: boolean,
  textColor?: number): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: y, width: LAYOUT.width, height: h,
    borderWidth: 0, borderColor: 0, paddingLength: LAYOUT.pad,
    containerID: id, containerName: name, content, isEventCapture: capture ? 1 : 0,
    ...(textColor === undefined ? {} : { textColor }),
  });
}

function layoutKey(page: PageSpec): string {
  return page.kind === 'list' ? `list:${page.items.join('\u0001')}` : 'text';
}

function containers(page: PageSpec): { textObject: TextContainerProperty[]; listObject?: ListContainerProperty[] } {
  const header = textBox(IDS.header, NAMES.header, LAYOUT.header.y, LAYOUT.header.h, page.header, false);
  const footer = textBox(IDS.footer, NAMES.footer, LAYOUT.footer.y, LAYOUT.footer.h, page.footer, false, 2);
  if (page.kind === 'text') {
    const body = textBox(IDS.body, NAMES.body, LAYOUT.body.y, LAYOUT.body.h, page.body, true);
    return { textObject: [header, body, footer] };
  }
  const list = new ListContainerProperty({
    xPosition: 0, yPosition: LAYOUT.body.y, width: LAYOUT.width, height: LAYOUT.body.h,
    borderWidth: 0, borderColor: 0, paddingLength: LAYOUT.pad,
    containerID: IDS.list, containerName: NAMES.list, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: page.items.length, itemName: page.items, isItemSelectBorderEn: 1,
    }),
  });
  return { textObject: [header, footer], listObject: [list] };
}

/** Short, content-free description of a page for the phone log. */
export function describe(page: PageSpec): string {
  if (page.kind === 'text') return `text body=${page.body.length}ch`;
  const bytes = page.items.map(utf8Bytes);
  const nonAscii = page.items.some((i) => /[^\x20-\x7E]/.test(i));
  return `list rows=${page.items.length} maxBytes=${Math.max(0, ...bytes)} nonAscii=${nonAscii}`;
}

/** Progressively safer versions of a list page. Row order is preserved so tap indices still map. */
export function safeListVariants(page: Extract<PageSpec, { kind: 'list' }>): Array<[string, PageSpec]> {
  const rows = (maxBytes: number, count: number, strict = false) => page.items.slice(0, count).map((i) => {
    const ascii = toAscii(i);
    return capBytes(strict ? ascii.replace(/[^A-Za-z0-9 +:.-]/g, '') : ascii, maxBytes) || '-';
  });
  return [
    ['ascii-48B', { ...page, items: rows(48, 20) }],
    ['ascii-32B-10rows', { ...page, items: rows(32, 10) }],
    ['strict-24B-5rows', { ...page, header: toAscii(page.header), footer: toAscii(page.footer), items: rows(24, 5, true) }],
  ];
}

/** Renders PageSpecs, rebuilding only when the layout changes and patching text otherwise. */
export class GlassesDisplay implements Display {
  private last: PageSpec | null = null;
  private created = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly bridge: EvenAppBridge, private readonly log: (m: string) => void) {}

  show(page: PageSpec): Promise<void> {
    this.queue = this.queue.then(() => this.apply(page)).catch((err) => this.log(`display: ${String(err)}`));
    return this.queue;
  }

  private async apply(page: PageSpec): Promise<void> {
    const prev = this.last;
    this.last = page;
    if (!this.created || !prev || layoutKey(prev) !== layoutKey(page)) {
      try {
        await this.rebuild(page);
        return;
      } catch (err) {
        this.log(`display rebuild failed: ${describe(page)}: ${String(err)}`);
      }
      // Lists: retry progressively safer variants and log which one the glasses accept.
      if (page.kind === 'list') {
        for (const [label, variant] of safeListVariants(page)) {
          try {
            await this.rebuild(variant);
            this.last = variant;
            this.log(`list fallback OK: ${label} (${describe(variant)})`);
            return;
          } catch {
            this.log(`list fallback failed: ${label}`);
          }
        }
      }
      // Never leave the previous screen up silently; show what failed on the glasses.
      const fallback: PageSpec = { kind: 'text', header: 'Display error', footer: 'double-tap: back',
        body: 'The glasses rejected this screen. Details are in the phone app activity log.' };
      this.last = fallback;
      await this.rebuild(fallback);
      return;
    }
    await this.patch(NAMES.header, IDS.header, prev.header, page.header);
    if (prev.kind === 'text' && page.kind === 'text') await this.patch(NAMES.body, IDS.body, prev.body, page.body);
    await this.patch(NAMES.footer, IDS.footer, prev.footer, page.footer);
  }

  /** Epoch ms when a list page last finished drawing (0 if none). Used to drop the host's settle echo. */
  listShownAt = 0;

  private async rebuild(page: PageSpec): Promise<void> {
    const parts = containers(page);
    const total = parts.textObject.length + (parts.listObject?.length ?? 0);
    // The host's settle echo can arrive before the rebuild promise resolves, so stamp before and after.
    this.listShownAt = page.kind === 'list' ? Date.now() : 0;
    if (!this.created) {
      const res = await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: total, ...parts }));
      if (res !== StartUpPageCreateResult.success) throw new Error(`createStartUpPageContainer: ${res}`);
      this.created = true;
    } else {
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: total, ...parts }));
      if (!ok) throw new Error('rebuildPageContainer failed');
    }
    this.listShownAt = page.kind === 'list' ? Date.now() : 0;
  }

  private async patch(name: string, id: number, before: string, after: string): Promise<void> {
    if (before === after) return;
    await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content: after }));
  }
}

/** Collects glasses-mic PCM between start() and stop(). Feed frames via push(). */
export class GlassesMic implements Mic {
  private chunks: Uint8Array[] = [];
  private active = false;

  constructor(private readonly bridge: EvenAppBridge) {}

  push(pcm: Uint8Array): void {
    if (this.active) this.chunks = [...this.chunks, pcm];
  }

  async start(): Promise<boolean> {
    this.chunks = [];
    this.active = await this.bridge.audioControl(true, AudioInputSource.Glasses);
    return this.active;
  }

  async stop(): Promise<Uint8Array> {
    const wasActive = this.active;
    this.active = false;
    if (wasActive) await this.bridge.audioControl(false);
    const wav = pcmToWav(this.chunks);
    this.chunks = [];
    return wav;
  }
}
