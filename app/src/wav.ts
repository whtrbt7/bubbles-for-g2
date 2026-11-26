export const SAMPLE_RATE = 16000;
const HEADER_BYTES = 44;

/** Concatenate raw S16LE mono PCM chunks from the glasses mic into a WAV file. */
export function pcmToWav(chunks: readonly Uint8Array[], sampleRate = SAMPLE_RATE): Uint8Array {
  const dataLength = chunks.reduce((sum, c) => sum + c.length, 0) & ~1; // whole 16-bit samples
  const out = new Uint8Array(HEADER_BYTES + dataLength);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  let offset = HEADER_BYTES;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, HEADER_BYTES + dataLength - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

export function pcmSeconds(chunks: readonly Uint8Array[], sampleRate = SAMPLE_RATE): number {
  return chunks.reduce((sum, c) => sum + c.length, 0) / (sampleRate * 2);
}
