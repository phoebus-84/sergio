// ComfyUI's SaveAudio node writes FLAC. This reads what a FLAC file says of
// itself — sample rate, channels, length — from its STREAMINFO block, so a
// caller knows how long the speech is without decoding it.

export interface FlacInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  durationSeconds: number;
}

/** STREAMINFO of a FLAC file, or null when the bytes are not FLAC. */
export function flacInfo(bytes: Uint8Array): FlacInfo | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // "fLaC", a 4-byte block header (type 0 = STREAMINFO), then 34 bytes of it
  if (b.length < 42 || b.toString("latin1", 0, 4) !== "fLaC" || (b[4]! & 0x7f) !== 0) return null;
  const at = 8 + 10; // past the block and frame sizes
  const sampleRate = (b[at]! << 12) | (b[at + 1]! << 4) | (b[at + 2]! >> 4);
  const channels = ((b[at + 2]! >> 1) & 0x07) + 1;
  const bitsPerSample = (((b[at + 2]! & 0x01) << 4) | (b[at + 3]! >> 4)) + 1;
  const totalSamples = (b[at + 3]! & 0x0f) * 2 ** 32 + b.readUInt32BE(at + 4);
  if (sampleRate === 0) return null;
  return { sampleRate, channels, bitsPerSample, totalSamples, durationSeconds: totalSamples / sampleRate };
}
