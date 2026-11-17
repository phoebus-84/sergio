// WAV in and out: float for what a render gives (it may pass full scale), PCM for a file to hand on.

import { StrudelError } from "./errors.js";

export type WavFormat = "f32" | "pcm24" | "pcm16";

export function encodeWav(channels: Float32Array[], sampleRate: number, format: WavFormat = "f32"): Buffer {
  const count = channels.length;
  if (count === 0) throw new StrudelError("bad-options", "a WAV needs at least one channel");
  const frames = channels[0]!.length;
  const bytes = format === "f32" ? 4 : format === "pcm24" ? 3 : 2;
  const data = frames * count * bytes;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(format === "f32" ? 3 : 1, 20);
  out.writeUInt16LE(count, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * count * bytes, 28);
  out.writeUInt16LE(count * bytes, 32);
  out.writeUInt16LE(bytes * 8, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(data, 40);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const sample = channels[c]![i]!;
      if (format === "f32") {
        out.writeFloatLE(sample, at);
      } else {
        const clamped = Math.max(-1, Math.min(1, sample));
        if (format === "pcm24") out.writeIntLE(Math.round(clamped * 8388607), at, 3);
        else out.writeInt16LE(Math.round(clamped * 32767), at);
      }
      at += bytes;
    }
  }
  return out;
}

export function decodeWav(file: Buffer): { channels: Float32Array[]; sampleRate: number } {
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw new StrudelError("bad-options", "not a WAV file");
  let format = 0;
  let count = 0;
  let sampleRate = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= file.length;) {
    const id = file.toString("ascii", at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = file.readUInt16LE(body);
      count = file.readUInt16LE(body + 2);
      sampleRate = file.readUInt32LE(body + 4);
      bits = file.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format
      if (format === 0xfffe && size >= 26) format = file.readUInt16LE(body + 24);
    } else if (id === "data") {
      const bytes = bits / 8;
      if (!count || !bytes || (format !== 1 && format !== 3)) throw new StrudelError("bad-options", "a WAV of a kind this cannot read");
      const frames = Math.floor(Math.min(size, file.length - body) / (count * bytes));
      const channels = Array.from({ length: count }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < count; c++) {
          channels[c]![i] = format === 3
            ? (bytes === 8 ? file.readDoubleLE(p) : file.readFloatLE(p))
            : bytes === 2 ? file.readInt16LE(p) / 32768 : bytes === 3 ? file.readIntLE(p, 3) / 8388608 : bytes === 4 ? file.readInt32LE(p) / 2147483648 : (file.readUInt8(p) - 128) / 128;
          p += bytes;
        }
      }
      return { channels, sampleRate };
    }
    at = body + size + (size % 2);
  }
  throw new StrudelError("bad-options", "a WAV with no audio in it");
}
