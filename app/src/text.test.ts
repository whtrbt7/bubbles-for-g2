import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import { describe, expect, it } from 'vitest';
import { capBytes, capChars, clampLines, fitWidth, paginateLines, relativeTime, sanitize, toAscii } from './text';

describe('sanitize', () => {
  it('replaces emoji the firmware cannot draw and flattens newlines', () => {
    expect(sanitize('ok 👍🏽 see\nyou')).toBe('ok * see you');
  });
  it('keeps double-space column gaps but caps longer runs', () => {
    expect(sanitize('Mom  2m     hi')).toBe('Mom  2m  hi');
  });
  it('keeps a hint when a message is only emoji', () => {
    expect(sanitize('❤️')).toBe('*');
    expect(sanitize('   ')).toBe('[emoji]');
  });
});

describe('fitWidth', () => {
  it('leaves short text alone', () => {
    expect(fitWidth('Mom', 200)).toBe('Mom');
  });
  it('ellipsizes to fit the pixel budget', () => {
    const long = 'This is a very long preview line that cannot possibly fit in the row';
    const out = fitWidth(long, 200);
    expect(out.endsWith('…')).toBe(true);
    expect(getTextWidth(out)).toBeLessThanOrEqual(200);
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 10, 25, 12);
  it.each([
    [now - 10_000, 'now'],
    [now - 5 * 60_000, '5m'],
    [now - 3 * 3_600_000, '3h'],
    [now - 2 * 86_400_000, '2d'],
  ])('formats %s as %s', (at, expected) => {
    expect(relativeTime(at, now)).toBe(expected);
  });
  it('uses month/day beyond a week', () => {
    expect(relativeTime(now - 10 * 86_400_000, now)).toMatch(/^\d{1,2}\/\d{1,2}$/);
  });
});

describe('paginateLines', () => {
  const width = 568;
  it('puts everything on one page when it fits', () => {
    expect(paginateLines(['Mom: hi', 'You: hey'], width, 7)).toEqual(['Mom: hi\nYou: hey']);
  });
  it('keeps the newest page full and every page within the line budget', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Mom: message number ${i} with some extra words`);
    const pages = paginateLines(lines, width, 7);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(measureTextWrap(page, width).lineCount).toBeLessThanOrEqual(7);
    expect(pages.at(-1)).toContain('message number 29');
    expect(pages[0]).toContain('message number 0');
  });
  it('splits a single huge message across pages', () => {
    const huge = `Mom: ${'word '.repeat(400)}`;
    const pages = paginateLines([huge], width, 3);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(measureTextWrap(page, width).lineCount).toBeLessThanOrEqual(3);
  });
});

describe('capBytes / toAscii', () => {
  it('caps by UTF-8 bytes without splitting characters', () => {
    const out = capBytes('é'.repeat(50), 64); // 2 bytes each
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(64);
    expect(out.endsWith('...')).toBe(true);
    expect(capBytes('short', 64)).toBe('short');
  });
  it('folds accents and smart punctuation to ASCII', () => {
    expect(toAscii('José’s “Café” — ok…')).toBe('Jose\'s "Cafe" - ok...');
    expect(toAscii('東京 hi')).toBe(' hi');
  });
});

describe('capChars', () => {
  it('caps by code points and marks the cut', () => {
    expect(capChars('abcdef', 4)).toBe('abc…');
    expect([...capChars('x'.repeat(100), 64)].length).toBe(64);
    expect(capChars('short', 64)).toBe('short');
  });
});

describe('clampLines', () => {
  it('preserves line breaks between thread messages', () => {
    expect(clampLines('Mom: hi\nYou: hey', 568, 7)).toBe('Mom: hi\nYou: hey');
  });
  it('truncates long bodies to the line budget', () => {
    const out = clampLines('lorem ipsum '.repeat(200), 568, 3);
    expect(measureTextWrap(out, 568).lineCount).toBeLessThanOrEqual(3);
    expect(out.endsWith('…')).toBe(true);
  });
});
