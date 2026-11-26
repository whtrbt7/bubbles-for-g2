import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { describe, expect, it } from 'vitest';
import { isListSettleEcho, LIST_SETTLE_MS, toInput } from './input';

describe('isListSettleEcho', () => {
  const echo = { listEvent: { } };
  it('flags an untyped list event right after a list is drawn', () => {
    expect(isListSettleEcho(echo, 300)).toBe(true);
  });
  it('flags the echo when the SDK fills in default CLICK / index 0', () => {
    expect(isListSettleEcho({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT, currentSelectItemIndex: 0 } }, 300)).toBe(true);
  });
  it('treats the same event as a real tap once the list has settled', () => {
    expect(isListSettleEcho(echo, LIST_SETTLE_MS + 1)).toBe(false);
  });
  it('never swallows taps that carry an index or type', () => {
    expect(isListSettleEcho({ listEvent: { currentSelectItemIndex: 2 } }, 100)).toBe(false);
    expect(isListSettleEcho({ listEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }, 100)).toBe(false);
    expect(isListSettleEcho({ sysEvent: {} }, 100)).toBe(false);
  });
});

describe('toInput', () => {
  it('treats an envelope without eventType as a tap (CLICK=0 is dropped on the wire)', () => {
    expect(toInput({ sysEvent: {} })).toEqual({ kind: 'click', index: 0 });
  });
  it('reads the selected list index on tap', () => {
    expect(toInput({ listEvent: { currentSelectItemIndex: 3 } })).toEqual({ kind: 'click', index: 3 });
  });
  it('defaults a missing list index to 0', () => {
    expect(toInput({ listEvent: { eventType: OsEventTypeList.CLICK_EVENT } })).toEqual({ kind: 'click', index: 0 });
  });
  it('prefers specific gestures over the tap fallback across envelopes', () => {
    expect(toInput({ textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }, sysEvent: {} }))
      .toEqual({ kind: 'back' });
  });
  it.each([
    [OsEventTypeList.SCROLL_TOP_EVENT, 'up'],
    [OsEventTypeList.SCROLL_BOTTOM_EVENT, 'down'],
    [OsEventTypeList.LONG_PRESS_EVENT, 'holdStart'],
    [OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 'holdEnd'],
    [OsEventTypeList.FOREGROUND_EXIT_EVENT, 'background'],
    [OsEventTypeList.SYSTEM_EXIT_EVENT, 'exit'],
  ])('maps %s to %s', (eventType, kind) => {
    expect(toInput({ textEvent: { eventType } })).toEqual({ kind });
  });
  it('ignores events with no input envelope (audio frames)', () => {
    expect(toInput({})).toBeNull();
  });
  it('ignores IMU reports', () => {
    expect(toInput({ sysEvent: { eventType: OsEventTypeList.IMU_DATA_REPORT } })).toBeNull();
  });
});
