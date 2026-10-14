// Tiny pure-JS image helpers (no native deps – works locally and on Vercel).

/** Read pixel dimensions from a PNG or JPEG buffer. */
export function imageSize(buf: Buffer): { width: number; height: number } {
  // PNG: IHDR at offset 16 (width/height big-endian uint32).
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan for a Start-Of-Frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      // SOF0..SOF15 except DHT(C4) RST(C8) JPG(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2); // skip this segment
    }
  }
  return { width: 0, height: 0 };
}

const SUPPORTED: { label: string; r: number }[] = [
  { label: '1:1', r: 1 }, { label: '2:3', r: 2 / 3 }, { label: '3:2', r: 3 / 2 },
  { label: '3:4', r: 3 / 4 }, { label: '4:3', r: 4 / 3 }, { label: '4:5', r: 4 / 5 },
  { label: '5:4', r: 5 / 4 }, { label: '9:16', r: 9 / 16 }, { label: '16:9', r: 16 / 9 },
  { label: '21:9', r: 21 / 9 },
];

/** Nearest Gemini-supported aspect-ratio label for a given image (default 16:9). */
export function nearestAspectRatio(buf: Buffer): string {
  const { width, height } = imageSize(buf);
  if (!width || !height) return '16:9';
  const r = width / height;
  return SUPPORTED.reduce((best, cur) =>
    Math.abs(cur.r - r) < Math.abs(best.r - r) ? cur : best).label;
}
