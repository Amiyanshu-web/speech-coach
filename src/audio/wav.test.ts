import { describe, expect, test } from "bun:test";
import { wavPeaks } from "./wav";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const i16 = (samples: readonly number[]) => samples.flatMap((s) => u16(s < 0 ? s + 65536 : s));

const fmt = (tag: number, channels: number, bits: number) => [
  ...ascii("fmt "), ...u32(16), ...u16(tag), ...u16(channels), ...u32(16000),
  ...u32((16000 * channels * bits) / 8), ...u16((channels * bits) / 8), ...u16(bits),
];
const dataChunk = (samples: readonly number[], declared?: number) => {
  const body = i16(samples);
  return [...ascii("data"), ...u32(declared ?? body.length), ...body];
};
const wav = (...chunks: number[][]) => {
  const body = [...ascii("WAVE"), ...chunks.flat()];
  return new Uint8Array([...ascii("RIFF"), ...u32(body.length), ...body]);
};

describe("wavPeaks", () => {
  test("takes the largest absolute sample per bucket and scales so the loudest bucket is 1", () => {
    const bytes = wav(fmt(1, 1, 16), dataChunk([100, -200, 50, 400, 0, -800, 10, 20]));
    expect(wavPeaks(bytes, 4)).toEqual([0.25, 0.5, 1, 0.025]);
  });

  test("reads the data chunk after a LIST chunk, with an odd-sized chunk padded to even", () => {
    const list = [...ascii("LIST"), ...u32(5), 1, 2, 3, 4, 5, 0];
    const bytes = wav(fmt(1, 1, 16), list, dataChunk([0, 1000, 0, 500]));
    expect(wavPeaks(bytes, 2)).toEqual([1, 0.5]);
  });

  test("finds fmt after another chunk, and handles the -32768 extreme", () => {
    const list = [...ascii("LIST"), ...u32(4), 1, 2, 3, 4];
    expect(wavPeaks(wav(list, fmt(1, 1, 16), dataChunk([-32768, 16384])), 2)).toEqual([1, 0.5]);
  });

  test("uses the larger channel of each stereo frame", () => {
    const bytes = wav(fmt(1, 2, 16), dataChunk([100, -300, 200, 50, 10, 10, 0, 0]));
    expect(wavPeaks(bytes, 2)).toEqual([1, 0.033]);
  });

  test("a streamed header with a too-large data size reads to the end of the bytes", () => {
    const bytes = wav(fmt(1, 1, 16), dataChunk([0, 400, 0, 200], 0xffffffff));
    expect(wavPeaks(bytes, 2)).toEqual([1, 0.5]);
  });

  test("silence gives all zeros, and fewer samples than buckets still returns every bucket", () => {
    expect(wavPeaks(wav(fmt(1, 1, 16), dataChunk([0, 0, 0, 0])), 2)).toEqual([0, 0]);
    const few = wavPeaks(wav(fmt(1, 1, 16), dataChunk([1000, 500])), 4) ?? [];
    expect(few).toHaveLength(4);
    expect(Math.max(...few)).toBe(1);
  });

  test("returns null for anything that is not 16-bit PCM mono or stereo WAV", () => {
    expect(wavPeaks(wav(fmt(3, 1, 16), dataChunk([1, 2])), 2)).toBeNull();
    expect(wavPeaks(wav(fmt(1, 1, 8), dataChunk([1, 2])), 2)).toBeNull();
    expect(wavPeaks(wav(fmt(1, 3, 16), dataChunk([1, 2, 3])), 2)).toBeNull();
    expect(wavPeaks(wav(fmt(1, 1, 16)), 2)).toBeNull();
    expect(wavPeaks(wav(dataChunk([1, 2])), 2)).toBeNull();
    expect(wavPeaks(new Uint8Array([1, 2, 3]), 2)).toBeNull();
    expect(wavPeaks(new Uint8Array(), 2)).toBeNull();
    const notWave = wav(fmt(1, 1, 16), dataChunk([1, 2]));
    notWave.set(ascii("AVI "), 8);
    expect(wavPeaks(notWave, 2)).toBeNull();
  });

  test("a fmt chunk cut short, or a chunk size that runs past the bytes, gives null", () => {
    const whole = wav(fmt(1, 1, 16), dataChunk([1, 2]));
    expect(wavPeaks(whole.slice(0, 12 + 8 + 10), 2)).toBeNull();
    expect(wavPeaks(wav([...ascii("LIST"), ...u32(0xffffffff)], fmt(1, 1, 16), dataChunk([1, 2])), 2)).toBeNull();
  });

  test("a trailing half sample is ignored, and zero buckets give an empty list", () => {
    const odd = wav(fmt(1, 1, 16), [...ascii("data"), ...u32(5), ...i16([0, 500]), 255, 0]);
    expect(wavPeaks(odd, 2)).toEqual([0, 1]);
    expect(wavPeaks(wav(fmt(1, 1, 16), dataChunk([1, 2])), 0)).toEqual([]);
  });

  test("works on a view into a larger buffer", () => {
    const inner = wav(fmt(1, 1, 16), dataChunk([0, 600]));
    const big = new Uint8Array(inner.length + 6);
    big.set(inner, 3);
    expect(wavPeaks(big.subarray(3, 3 + inner.length), 2)).toEqual([0, 1]);
  });
});
