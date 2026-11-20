const tag = (v: DataView, at: number): string =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

type Format = { channels: number };

/**
 * Loudness per bucket of a 16-bit PCM mono or stereo WAV, scaled so the loudest bucket is 1.
 * Walks the chunks, so extra chunks before `data` are fine. Null for any other format.
 */
export const wavPeaks = (bytes: Uint8Array, buckets: number): number[] | null => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || tag(v, 0) !== "RIFF" || tag(v, 8) !== "WAVE") return null;
  let format: Format | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(v, at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) return null;
      const channels = v.getUint16(body + 2, true);
      const bits = v.getUint16(body + 14, true);
      if (v.getUint16(body, true) !== 1 || bits !== 16 || (channels !== 1 && channels !== 2)) return null;
      format = { channels };
    } else if (id === "data") {
      if (!format) return null;
      const end = Math.min(body + size, bytes.length);
      return bucketPeaks(v, body, end, format.channels, buckets);
    }
    at = body + size + (size % 2);
  }
  return null;
};

const bucketPeaks = (v: DataView, start: number, end: number, channels: number, buckets: number): number[] => {
  const step = 2 * channels;
  const frames = Math.floor((end - start) / step);
  const peaks = Array.from({ length: buckets }, (_, b) => {
    const from = Math.floor((b * frames) / buckets);
    const to = Math.min(frames, Math.max(from + 1, Math.floor(((b + 1) * frames) / buckets)));
    let max = 0;
    for (let f = from; f < to; f++) {
      for (let c = 0; c < channels; c++) max = Math.max(max, Math.abs(v.getInt16(start + f * step + c * 2, true)));
    }
    return max;
  });
  const top = Math.max(...peaks);
  return peaks.map((p) => (top === 0 ? 0 : Math.round((p / top) * 1000) / 1000));
};
