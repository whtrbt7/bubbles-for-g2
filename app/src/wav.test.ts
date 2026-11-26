import { describe, expect, it } from 'vitest';
import { pcmSeconds, pcmToWav } from './wav';

describe('pcmToWav', () => {
  it('writes a valid 16 kHz mono 16-bit header', () => {
    const wav = pcmToWav([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]);
    const view = new DataView(wav.buffer);
    const ascii = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(ascii(36)).toBe('data');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('drops a trailing odd byte so samples stay aligned', () => {
    const wav = pcmToWav([new Uint8Array([1, 2, 3])]);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(2);
    expect(wav.length).toBe(46);
  });

  it('handles no audio', () => {
    expect(pcmToWav([]).length).toBe(44);
  });
});

describe('pcmSeconds', () => {
  it('counts 32000 bytes per second', () => {
    expect(pcmSeconds([new Uint8Array(16000), new Uint8Array(16000)])).toBe(1);
  });
});
