import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import type { Message } from './types';

export const LINE_HEIGHT = 27;
const ELLIPSIS = '…';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Firmware fonts have no emoji glyphs; keep the hint that one was there.
const EMOJI_PART = String.raw`(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Emoji_Modifier}\u{FE0F}]*`;
const PICTOGRAPHIC = new RegExp(`${EMOJI_PART}(?:\\u{200D}${EMOJI_PART})*`, 'gu');
const INVISIBLE = /[\u{200B}-\u{200F}\u{FE0F}\u{FFFC}\p{Emoji_Modifier}]/gu;

/** Single-line, firmware-safe text. Keeps intentional double spaces (used as column gaps). */
export function sanitize(text: string): string {
  const cleaned = text
    .replace(PICTOGRAPHIC, '*')
    .replace(INVISIBLE, '')
    .replace(/[\t\r\n\f\v]+/g, ' ')
    .replace(/ {3,}/g, '  ')
    .trim();
  return cleaned || '[emoji]';
}

/** Trim `text` with an ellipsis so it renders within `maxWidth` pixels on one line. */
export function fitWidth(text: string, maxWidth: number): string {
  if (getTextWidth(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getTextWidth(text.slice(0, mid).trimEnd() + ELLIPSIS) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + ELLIPSIS;
}

/** Hard cap on characters (code points). Firmware rejects whole pages when a field exceeds its limit. */
export function capChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join('').trimEnd() + ELLIPSIS;
}

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/** Hard cap on UTF-8 bytes, cutting on code-point boundaries and marking the cut with ASCII "...". */
export function capBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const chars = [...text];
  let out = '';
  for (const ch of chars) {
    if (utf8Bytes(out + ch) + 3 > maxBytes) break;
    out += ch;
  }
  return `${out.trimEnd()}...`;
}

/** Fold to printable ASCII: strip accents, map smart punctuation, drop anything else. */
export function toAscii(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '');
}

export function relativeTime(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function messageLine(m: Message): string {
  const who = m.fromMe ? 'You' : m.sender.split(' ')[0];
  return `${who}: ${sanitize(m.text)}`;
}

/**
 * Split thread lines into pages that fit `maxLines` at `width` px.
 * Pages are ordered oldest → newest; the last page holds the newest messages.
 * A single message longer than a page is hard-wrapped across pages.
 */
export function paginateLines(lines: readonly string[], width: number, maxLines: number): string[] {
  const pages: string[][] = [];
  let current: string[] = [];
  let used = 0;
  // Fill from the newest end so the newest page is always full.
  for (let i = lines.length - 1; i >= 0; i--) {
    const pieces = splitToFit(lines[i], width, maxLines);
    for (let p = pieces.length - 1; p >= 0; p--) {
      const n = measureTextWrap(pieces[p], width).lineCount;
      if (used + n > maxLines && current.length) {
        pages.unshift(current);
        current = [];
        used = 0;
      }
      current.unshift(pieces[p]);
      used += n;
    }
  }
  if (current.length) pages.unshift(current);
  return pages.map((page) => page.join('\n'));
}

function splitToFit(line: string, width: number, maxLines: number): string[] {
  if (measureTextWrap(line, width).lineCount <= maxLines) return [line];
  const words = line.split(' ');
  const out: string[] = [];
  let buf = '';
  for (const word of words) {
    const next = buf ? `${buf} ${word}` : word;
    if (measureTextWrap(next, width).lineCount > maxLines && buf) {
      out.push(buf);
      buf = word;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Wrap a free-form body (transcript, error) and cut it to `maxLines`. */
export function clampLines(text: string, width: number, maxLines: number): string {
  const clean = text.split('\n').map((line) => (line.trim() ? sanitize(line) : '')).join('\n');
  if (measureTextWrap(clean, width).lineCount <= maxLines) return clean;
  let lo = 0;
  let hi = clean.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureTextWrap(clean.slice(0, mid) + ELLIPSIS, width).lineCount <= maxLines) lo = mid;
    else hi = mid - 1;
  }
  return clean.slice(0, lo).trimEnd() + ELLIPSIS;
}
