import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import type { Input } from './types';

interface Envelope {
  eventType?: OsEventTypeList;
  currentSelectItemIndex?: number;
}

export interface HubEventLike {
  listEvent?: Envelope;
  textEvent?: Envelope;
  sysEvent?: Envelope;
}

// CLICK_EVENT is 0 and protobuf drops zero fields, so an envelope with no eventType is a tap.
const typeOf = (env?: Envelope): OsEventTypeList | null =>
  env ? (env.eventType ?? OsEventTypeList.CLICK_EVENT) : null;

const SPECIFIC: Array<[OsEventTypeList, Input]> = [
  [OsEventTypeList.DOUBLE_CLICK_EVENT, { kind: 'back' }],
  [OsEventTypeList.LONG_PRESS_EVENT, { kind: 'holdStart' }],
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT, { kind: 'holdEnd' }],
  [OsEventTypeList.SCROLL_TOP_EVENT, { kind: 'up' }],
  [OsEventTypeList.SCROLL_BOTTOM_EVENT, { kind: 'down' }],
  [OsEventTypeList.FOREGROUND_ENTER_EVENT, { kind: 'foreground' }],
  [OsEventTypeList.FOREGROUND_EXIT_EVENT, { kind: 'background' }],
  [OsEventTypeList.SYSTEM_EXIT_EVENT, { kind: 'exit' }],
  [OsEventTypeList.ABNORMAL_EXIT_EVENT, { kind: 'exit' }],
];

/**
 * The host emits an untyped listEvent right after a list page is drawn. It is byte-identical to a
 * real tap on row 0 (zero values are dropped on the wire), so the only tell is timing.
 */
export const LIST_SETTLE_MS = 800;

export function isListSettleEcho(event: HubEventLike, msSinceListShown: number): boolean {
  const list = event.listEvent;
  if (!list || event.sysEvent || event.textEvent) return false;
  // The SDK may materialize missing fields as their defaults (CLICK, index 0), so accept both forms.
  const tapLike = list.eventType === undefined || list.eventType === OsEventTypeList.CLICK_EVENT;
  const rowZero = !list.currentSelectItemIndex;
  return tapLike && rowZero && msSinceListShown >= 0 && msSinceListShown < LIST_SETTLE_MS;
}

/** Normalize one SDK hub event into an app Input. Audio-only and IMU events map to null. */
export function toInput(event: HubEventLike): Input | null {
  const types = [typeOf(event.listEvent), typeOf(event.textEvent), typeOf(event.sysEvent)]
    .filter((t): t is OsEventTypeList => t !== null);
  if (!types.length) return null;
  for (const [type, input] of SPECIFIC) {
    if (types.includes(type)) return input;
  }
  if (types.includes(OsEventTypeList.CLICK_EVENT)) {
    return { kind: 'click', index: event.listEvent?.currentSelectItemIndex ?? 0 };
  }
  return null;
}
