import sharp from "sharp";

// Wallpaper Engine .tex layout (reverse-engineered from editor-made files):
//   "TEXV0005\0" "TEXI0001\0"
//   i32 format (0 RGBA8888, 4 DXT5, 6 DXT3, 7 DXT1, 8 RG88, 9 R8), i32 flags (1 nointerp, 2 clamp),
//   i32 texW, texH, imgW, imgH, u32 average colour (RGBA bytes)
//   "TEXB0003\0" (0004 adds an i32 after imageFormat), i32 imageCount, i32 imageFormat (-1 raw, else FreeImage id)
//   per image: i32 mipCount, per mip: i32 w, h, lz4(0/1), rawSize, byteSize, bytes
//   sprite sheet / GIF (flags & 4): "TEXS0003\0" i32 frameCount, i32 frameW, i32 frameH, then per frame
//   i32 image, f32 seconds, f32 x, y, w, 0, 0, h   (x, y, w, h = the frame inside the sheet, px)

export const TEX_RGBA8888 = 0, TEX_DXT5 = 4, TEX_DXT3 = 6, TEX_DXT1 = 7, TEX_RG88 = 8, TEX_R8 = 9;

export interface TexMip { w: number; h: number; data: Buffer }
export interface TexAnim { w: number; h: number; frames: { x: number; y: number; w: number; h: number; t: number }[] }
export interface Tex {
  anim?: TexAnim;
  format: number; flags: number; texW: number; texH: number; imgW: number; imgH: number; color: number;
  container: string; imageFormat: number; mips: TexMip[];
}

export const TEX_FORMAT_NAMES: Record<number, string> = { [TEX_RGBA8888]: "RGBA8888", [TEX_DXT5]: "DXT5", [TEX_DXT3]: "DXT3", [TEX_DXT1]: "DXT1", [TEX_RG88]: "RG88", [TEX_R8]: "R8" };

/** Header only (first 42 bytes, no mips decoded): format, padded size (texW/H) and real image size (imgW/H). */
export function texHeader(buf: Buffer): { format: number; flags: number; texW: number; texH: number; imgW: number; imgH: number } {
  if (buf.subarray(0, 8).toString("ascii") !== "TEXV0005") throw new Error("Not a TEXV0005 texture");
  const i = (n: number) => buf.readInt32LE(18 + 4 * n); // after "TEXV0005\0TEXI0001\0": format, flags, texW, texH, imgW, imgH
  return { format: i(0), flags: i(1), texW: i(2), texH: i(3), imgW: i(4), imgH: i(5) };
}

/**
 * Video memory of the top mip of a texture of the STORED size w x h (header texW/texH). Block formats round up to whole 4x4 blocks; the editor stores
 * DXT padded to powers of two (docs: performance/texture, 1920x1080 DXT5 -> 2048x2048), optimize_textures to multiples of 16: pass the padded size.
 * ponytail: mipmaps (+33%) are not counted; the editor's "Active texture memory" stat is the exact number.
 */
export function texBytes(format: number, w: number, h: number): number {
  const blocks = Math.ceil(w / 4) * Math.ceil(h / 4);
  if (format === TEX_DXT5 || format === TEX_DXT3) return blocks * 16;
  if (format === TEX_DXT1) return blocks * 8;
  return w * h * (format === TEX_RG88 ? 2 : format === TEX_R8 ? 1 : 4);
}

/* ---------------- LZ4 block ---------------- */

export function lz4Decompress(src: Buffer, outSize: number): Buffer {
  const out = Buffer.allocUnsafe(outSize);
  let i = 0, o = 0;
  while (i < src.length) {
    const t = src[i++];
    let ll = t >> 4;
    if (ll === 15) { let b; do { b = src[i++]; ll += b; } while (b === 255); }
    src.copy(out, o, i, i + ll); i += ll; o += ll;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let ml = t & 15;
    if (ml === 15) { let b; do { b = src[i++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let s = o - off, k = 0; k < ml; k++) out[o++] = out[s++];
  }
  if (o !== outSize) throw new Error(`LZ4: expected ${outSize} bytes, got ${o}`);
  return out;
}

export function lz4Compress(src: Buffer): Buffer {
  const n = src.length;
  const out = Buffer.allocUnsafe(n + Math.ceil(n / 255) + 32);
  let o = 0, anchor = 0, i = 0;
  const table = new Int32Array(1 << 16).fill(-1);
  const emitLen = (len: number) => { while (len >= 255) { out[o++] = 255; len -= 255; } out[o++] = len; };
  while (i + 12 <= n) {
    const seq = src.readUInt32LE(i);
    const h = (Math.imul(seq, 2654435761) >>> 16) & 0xffff;
    const ref = table[h]; table[h] = i;
    if (ref >= 0 && i - ref <= 65535 && src.readUInt32LE(ref) === seq) {
      let m = 4;
      while (i + m < n - 5 && src[ref + m] === src[i + m]) m++;
      const lit = i - anchor;
      out[o++] = (Math.min(lit, 15) << 4) | Math.min(m - 4, 15);
      if (lit >= 15) emitLen(lit - 15);
      src.copy(out, o, anchor, i); o += lit;
      out.writeUInt16LE(i - ref, o); o += 2;
      if (m - 4 >= 15) emitLen(m - 4 - 15);
      i += m; anchor = i;
    } else i++;
  }
  const lit = n - anchor;
  out[o++] = Math.min(lit, 15) << 4;
  if (lit >= 15) emitLen(lit - 15);
  src.copy(out, o, anchor, n); o += lit;
  return out.subarray(0, o);
}

/* ---------------- parse ---------------- */

export function parseTex(buf: Buffer): Tex {
  let o = 0;
  const i32 = () => { const v = buf.readInt32LE(o); o += 4; return v; };
  const str = () => { const e = buf.indexOf(0, o); const s = buf.toString("ascii", o, e); o = e + 1; return s; };
  if (str() !== "TEXV0005") throw new Error("Not a TEXV0005 texture");
  str(); // TEXI0001
  const format = i32(), flags = i32(), texW = i32(), texH = i32(), imgW = i32(), imgH = i32();
  const color = buf.readUInt32LE(o); o += 4;
  const container = str();
  const version = Number(container.slice(4));
  const imageCount = i32();
  let imageFormat = -1;
  if (version >= 3) imageFormat = i32();
  if (version >= 4) i32();
  const mips: TexMip[] = [];
  for (let img = 0; img < imageCount; img++) {
    const mipCount = i32();
    for (let m = 0; m < mipCount; m++) {
      const w = i32(), h = i32();
      let lz4 = 0, raw = 0;
      if (version >= 2) { lz4 = i32(); raw = i32(); }
      const size = i32();
      let data = buf.subarray(o, o + size); o += size;
      if (lz4) data = lz4Decompress(data, raw);
      if (img === 0) mips.push({ w, h, data });
    }
  }
  let anim: TexAnim | undefined;
  if ((flags & 4) && buf.toString("ascii", o, o + 4) === "TEXS") {
    const v = Number(str().slice(4)), f32 = () => { const x = buf.readFloatLE(o); o += 4; return x; };
    const n = i32(), w = v >= 3 ? i32() : imgW, h = v >= 3 ? i32() : imgH;
    anim = { w, h, frames: [] };
    for (let k = 0; k < n; k++) {
      i32(); const t = f32();
      const [x, y, fw, , , fh] = v >= 2 ? [f32(), f32(), f32(), f32(), f32(), f32()] : [i32(), i32(), i32(), i32(), i32(), i32()];
      anim.frames.push({ x, y, w: fw, h: fh, t });
    }
  }
  return { format, flags, texW, texH, imgW, imgH, color, container, imageFormat, mips, anim };
}

/* ---------------- decode to RGBA ---------------- */

function rgb565(c: number): [number, number, number] {
  return [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
}

function decodeDxt(fmt: number, d: Buffer, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4);
  const bs = fmt === TEX_DXT1 ? 8 : 16;
  let p = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    const cb = p + (bs === 16 ? 8 : 0);
    const c0 = d.readUInt16LE(cb), c1 = d.readUInt16LE(cb + 2);
    const a = rgb565(c0), b = rgb565(c1);
    const pal: number[][] = [[...a, 255], [...b, 255], [], []];
    if (c0 > c1 || bs === 16) {
      pal[2] = [(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3, 255];
      pal[3] = [(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3, 255];
    } else {
      pal[2] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 255];
      pal[3] = [0, 0, 0, 0];
    }
    const idx = d.readUInt32LE(cb + 4);
    const alpha: number[] = new Array(16).fill(255);
    if (fmt === TEX_DXT3) {
      for (let k = 0; k < 16; k++) alpha[k] = ((d[p + (k >> 1)] >> ((k & 1) * 4)) & 15) * 17;
    } else if (fmt === TEX_DXT5) {
      const a0 = d[p], a1 = d[p + 1];
      const tbl = [a0, a1];
      for (let k = 1; k <= (a0 > a1 ? 6 : 4); k++) tbl.push(a0 > a1 ? ((7 - k) * a0 + k * a1) / 7 : ((5 - k) * a0 + k * a1) / 5);
      if (a0 <= a1) tbl.push(0, 255);
      let bits = 0n;
      for (let k = 0; k < 6; k++) bits |= BigInt(d[p + 2 + k]) << BigInt(8 * k);
      for (let k = 0; k < 16; k++) alpha[k] = tbl[Number((bits >> BigInt(3 * k)) & 7n)];
    }
    for (let k = 0; k < 16; k++) {
      const x = bx + (k & 3), y = by + (k >> 2);
      if (x >= w || y >= h) continue;
      const c = pal[(idx >> (2 * k)) & 3], q = (y * w + x) * 4;
      out[q] = c[0]; out[q + 1] = c[1]; out[q + 2] = c[2]; out[q + 3] = fmt === TEX_DXT1 ? c[3] : alpha[k];
    }
    p += bs;
  }
  return out;
}

/** Decode the largest mip to straight RGBA8888, cropped to the real image size. */
export async function texToRgba(buf: Buffer): Promise<{ w: number; h: number; rgba: Buffer }> {
  const t = parseTex(buf);
  const mip = t.mips[0];
  let rgba: Buffer, w = mip.w, h = mip.h;
  if (t.imageFormat !== -1) {
    const r = await sharp(mip.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    rgba = r.data; w = r.info.width; h = r.info.height;
  } else if (t.format === TEX_RGBA8888) rgba = Buffer.from(mip.data);
  else if (t.format === TEX_R8 || t.format === TEX_RG88) {
    const ch = t.format === TEX_R8 ? 1 : 2;
    rgba = Buffer.alloc(w * h * 4, 255);
    for (let i = 0; i < w * h; i++) {
      const r = mip.data[i * ch]; rgba[i * 4] = r;
      rgba[i * 4 + 1] = ch === 2 ? mip.data[i * 2 + 1] : r; rgba[i * 4 + 2] = ch === 2 ? 0 : r;
    }
  } else if (t.format === TEX_DXT1 || t.format === TEX_DXT3 || t.format === TEX_DXT5) rgba = decodeDxt(t.format, mip.data, w, h);
  else throw new Error(`Unsupported texture format ${t.format}`);
  // a sprite sheet shows as its first frame everywhere (preview, masks, inspect); otherwise crop to the real image size
  const f0 = t.anim?.frames[0];
  const [x0, y0, cw, ch2] = f0 ? [f0.x, f0.y, Math.min(f0.w, w - f0.x), Math.min(f0.h, h - f0.y)] : [0, 0, Math.min(t.imgW, w), Math.min(t.imgH, h)];
  if (cw < w || ch2 < h) {
    const out = Buffer.alloc(cw * ch2 * 4);
    for (let y = 0; y < ch2; y++) rgba.copy(out, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4);
    return { w: cw, h: ch2, rgba: out };
  }
  return { w, h, rgba };
}

/* ---------------- encode ---------------- */

export interface EncodeOptions {
  /** "rgba" (colour textures), "r8" (single channel masks, red channel), "rg88" (two channels: normal maps use red + green),
   *  "dxt5" / "dxt1" (block compressed: a quarter of the video memory, slightly lossy; dxt1 has no alpha) */
  format?: "rgba" | "r8" | "rg88" | "dxt5" | "dxt1";
  /** disable bilinear filtering (pixel art) */
  nointerp?: boolean;
  /** repeat the texture at the edges instead of clamping (needed by the scroll effect) */
  tile?: boolean;
  /** write a full mip chain (default true for rgba, false for r8 like the editor) */
  mips?: boolean;
  compress?: boolean;
  /** bleed colours into transparent pixels (default true for rgba) */
  bleed?: boolean;
  /** the picture is a sprite sheet: frame size and where each frame sits (px), seconds per frame */
  sprite?: { w: number; h: number; frames: { x: number; y: number }[]; seconds: number };
}

function averageColor(rgba: Buffer, step: number): number {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4 * step) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
  return ((255 << 24) | (Math.round(b / n) << 16) | (Math.round(g / n) << 8) | Math.round(r / n)) >>> 0;
}

/**
 * Spread opaque colours a few pixels into fully transparent pixels (the editor's "bleedtransparentcolors"),
 * so bilinear filtering at cut-out edges doesn't pull in black. Modifies `rgba` in place.
 */
export function bleedTransparent(rgba: Buffer, w: number, h: number, iterations = 4): void {
  let any = false;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) { any = true; break; }
  if (!any) return;
  let filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = rgba[i * 4 + 3] > 0 ? 1 : 0;
  for (let it = 0; it < iterations; it++) {
    const next = filled.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (filled[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
        const j = yy * w + xx;
        if (filled[j]) { r += rgba[j * 4]; g += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; n++; }
      }
      if (n) { rgba[i * 4] = r / n; rgba[i * 4 + 1] = g / n; rgba[i * 4 + 2] = b / n; next[i] = 1; }
    }
    filled = next;
  }
}

/**
 * BC1 (DXT1, opaque) / BC3 (DXT5, with alpha) block compression of straight RGBA. Colour endpoints = the extreme pixels along the block's
 * principal axis, indices = nearest palette entry; alpha (DXT5) = min/max with 8 interpolated steps. Roughly what a fast encoder gives (a few dB under the best).
 * Mirrors decodeDxt below so the two stay each other's test.
 */
export function encodeDxt(px: Buffer, w: number, h: number, dxt5: boolean): Buffer {
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), bs = dxt5 ? 16 : 8;
  const out = Buffer.alloc(bw * bh * bs);
  const q565 = (r: number, g: number, b: number) => ((Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255));
  const P = new Array<number[]>(16);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let mr = 0, mg = 0, mb = 0, amin = 255, amax = 0;
    for (let k = 0; k < 16; k++) {
      const x = Math.min(w - 1, bx * 4 + (k & 3)), y = Math.min(h - 1, by * 4 + (k >> 2)), i = (y * w + x) * 4;
      P[k] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
      mr += px[i]; mg += px[i + 1]; mb += px[i + 2]; amin = Math.min(amin, px[i + 3]); amax = Math.max(amax, px[i + 3]);
    }
    mr /= 16; mg /= 16; mb /= 16;
    // principal axis of the colours (power iteration on the covariance)
    let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    for (const p of P) { const r = p[0] - mr, g = p[1] - mg, b = p[2] - mb; cxx += r * r; cxy += r * g; cxz += r * b; cyy += g * g; cyz += g * b; czz += b * b; }
    let ax = 1, ay = 1, az = 1;
    for (let it = 0; it < 4; it++) {
      const nx = cxx * ax + cxy * ay + cxz * az, ny = cxy * ax + cyy * ay + cyz * az, nz = cxz * ax + cyz * ay + czz * az;
      const l = Math.hypot(nx, ny, nz) || 1; ax = nx / l; ay = ny / l; az = nz / l;
    }
    let lo = 1e9, hi = -1e9, pl = P[0], ph = P[0];
    for (const p of P) { const t = (p[0] - mr) * ax + (p[1] - mg) * ay + (p[2] - mb) * az; if (t < lo) { lo = t; pl = p; } if (t > hi) { hi = t; ph = p; } }
    let c0 = q565(ph[0], ph[1], ph[2]), c1 = q565(pl[0], pl[1], pl[2]);
    if (c0 < c1) [c0, c1] = [c1, c0];
    let idx = 0;
    if (c0 !== c1) {            // c0 > c1: 4-colour mode (the decoder reads c0 <= c1 as the 3-colour + transparent mode of DXT1)
      const a = rgb565(c0), b = rgb565(c1);
      const pal = [a, b, [0, 1, 2].map(c => (2 * a[c] + b[c]) / 3), [0, 1, 2].map(c => (a[c] + 2 * b[c]) / 3)];
      for (let k = 0; k < 16; k++) {
        let best = 0, bd = 1e12;
        for (let n = 0; n < 4; n++) { const d = (P[k][0] - pal[n][0]) ** 2 + (P[k][1] - pal[n][1]) ** 2 + (P[k][2] - pal[n][2]) ** 2; if (d < bd) { bd = d; best = n; } }
        idx |= best << (2 * k);
      }
    }
    const o = (by * bw + bx) * bs, co = o + (dxt5 ? 8 : 0);
    out.writeUInt16LE(c0, co); out.writeUInt16LE(c1, co + 2); out.writeUInt32LE(idx >>> 0, co + 4);
    if (dxt5) {
      out[o] = amax; out[o + 1] = amin;
      if (amax > amin) {
        const tbl = [amax, amin]; for (let k = 1; k <= 6; k++) tbl.push(((7 - k) * amax + k * amin) / 7);
        let lowBits = 0, highBits = 0;     // 16 x 3 bits = 48: two 24-bit halves
        for (let k = 0; k < 16; k++) {
          let best = 0, bd = 1e9;
          for (let n = 0; n < 8; n++) { const d = Math.abs(P[k][3] - tbl[n]); if (d < bd) { bd = d; best = n; } }
          if (k < 8) lowBits |= best << (3 * k); else highBits |= best << (3 * (k - 8));
        }
        out[o + 2] = lowBits & 255; out[o + 3] = (lowBits >> 8) & 255; out[o + 4] = (lowBits >> 16) & 255;
        out[o + 5] = highBits & 255; out[o + 6] = (highBits >> 8) & 255; out[o + 7] = (highBits >> 16) & 255;
      }
    }
  }
  return out;
}

export async function encodeTex(rgba: Buffer, w: number, h: number, opt: EncodeOptions = {}): Promise<Buffer> {
  const r8 = opt.format === "r8", narrow = r8 || opt.format === "rg88", nch = r8 ? 1 : 2;
  const dxt = opt.format === "dxt5" || opt.format === "dxt1";
  if (!narrow && opt.bleed !== false) { rgba = Buffer.from(rgba); bleedTransparent(rgba, w, h); }
  const wantMips = opt.mips ?? !r8;
  const compress = opt.compress ?? true;
  // DXT: the stored image is padded (edge pixels repeated) to a multiple of 16 like the editor's non-power-of-two DXT1 files; imgW/H keep the real size
  const tw = dxt ? Math.ceil(w / 16) * 16 : w, th = dxt ? Math.ceil(h / 16) * 16 : h;
  const full = dxt && (tw !== w || th !== h) ? await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).extend({ right: tw - w, bottom: th - h, extendWith: "copy" }).raw().toBuffer() : rgba;
  const levels: TexMip[] = [];
  const toLevel = (px: Buffer, lw: number, lh: number): TexMip => {
    if (dxt) return { w: lw, h: lh, data: encodeDxt(px, lw, lh, opt.format === "dxt5") };
    if (!narrow) return { w: lw, h: lh, data: px };
    const d = Buffer.alloc(lw * lh * nch);
    for (let i = 0; i < lw * lh; i++) for (let c = 0; c < nch; c++) d[i * nch + c] = px[i * 4 + c];
    return { w: lw, h: lh, data: d };
  };
  levels.push(toLevel(full, tw, th));
  if (wantMips) {
    let lw = tw, lh = th;
    while (lw > 1 || lh > 1) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      const px = await sharp(full, { raw: { width: tw, height: th, channels: 4 } }).resize(lw, lh, { kernel: "lanczos3", fit: "fill" }).raw().toBuffer();
      levels.push(toLevel(px, lw, lh));
    }
  }
  const head = Buffer.alloc(18 + 28 + 9 + 12 + 4);
  let o = 0;
  const str = (s: string) => { head.write(s, o, "ascii"); o += s.length; head[o++] = 0; };
  const i32 = (v: number) => { head.writeInt32LE(v, o); o += 4; };
  str("TEXV0005"); str("TEXI0001");
  i32(r8 ? TEX_R8 : narrow ? TEX_RG88 : opt.format === "dxt5" ? TEX_DXT5 : opt.format === "dxt1" ? TEX_DXT1 : TEX_RGBA8888); i32((opt.nointerp ? 1 : 0) | (opt.tile ? 0 : 2) | (opt.sprite ? 4 : 0)); i32(tw); i32(th); i32(w); i32(h);
  head.writeUInt32LE(narrow ? 0xff000000 : averageColor(rgba, Math.max(1, Math.floor(w * h / 4096))), o); o += 4;
  str("TEXB0003"); i32(1); i32(-1); i32(levels.length);
  const parts: Buffer[] = [head.subarray(0, o)];
  for (const l of levels) {
    const body = compress ? lz4Compress(l.data) : l.data;
    const useLz4 = compress && body.length < l.data.length;
    const mh = Buffer.alloc(20);
    mh.writeInt32LE(l.w, 0); mh.writeInt32LE(l.h, 4); mh.writeInt32LE(useLz4 ? 1 : 0, 8);
    mh.writeInt32LE(l.data.length, 12); mh.writeInt32LE(useLz4 ? body.length : l.data.length, 16);
    parts.push(mh, useLz4 ? body : l.data);
  }
  const sp = opt.sprite;
  if (sp) {
    const s = Buffer.alloc(9 + 12 + sp.frames.length * 32);
    s.write("TEXS0003", 0, "ascii"); s.writeInt32LE(sp.frames.length, 9); s.writeInt32LE(sp.w, 13); s.writeInt32LE(sp.h, 17);
    sp.frames.forEach((f, k) => { const p = 21 + k * 32; s.writeFloatLE(sp.seconds, p + 4); s.writeFloatLE(f.x, p + 8); s.writeFloatLE(f.y, p + 12); s.writeFloatLE(sp.w, p + 16); s.writeFloatLE(sp.h, p + 28); });
    parts.push(s);
  }
  return Buffer.concat(parts);
}

/**
 * A video texture, byte for byte what the editor writes for an imported mp4 (TEXB0004, flags 32 + 2, one "mip" holding the whole mp4).
 * WE plays the mp4 that sits next to the .tex (materials/<name>.mp4).
 */
export function encodeVideoTex(mp4: Buffer, w: number, h: number): Buffer {
  const head = Buffer.alloc(9 + 9 + 28 + 9 + 36);
  let o = 0;
  const str = (s: string) => { head.write(s, o, "ascii"); o += s.length; head[o++] = 0; };
  const i32 = (v: number) => { head.writeInt32LE(v, o); o += 4; };
  str("TEXV0005"); str("TEXI0001");
  i32(TEX_RGBA8888); i32(32 | 2); i32(w); i32(h); i32(w); i32(h); i32(0);
  str("TEXB0004"); i32(1); i32(-1); i32(0); i32(1); i32(w); i32(h); i32(0); i32(0); i32(mp4.length);
  return Buffer.concat([head.subarray(0, o), mp4]);
}

/** Width x height of the first video track of an MP4 (tkhd box, 16.16 fixed point). Rotation metadata is not applied. */
export function mp4Size(b: Buffer): { w: number; h: number } {
  const boxes = (from: number, to: number, type: string) => {
    const out: { start: number; end: number }[] = [];
    for (let o = from; o + 8 <= to;) {
      let size = b.readUInt32BE(o), hdr = 8;
      if (size === 1) { size = Number(b.readBigUInt64BE(o + 8)); hdr = 16; } else if (size === 0) size = to - o;
      if (size < hdr) break;
      if (b.toString("latin1", o + 4, o + 8) === type) out.push({ start: o + hdr, end: Math.min(o + size, to) });
      o += size;
    }
    return out;
  };
  for (const moov of boxes(0, b.length, "moov")) for (const trak of boxes(moov.start, moov.end, "trak")) for (const tk of boxes(trak.start, trak.end, "tkhd")) {
    const w = b.readUInt32BE(tk.end - 8) / 65536, h = b.readUInt32BE(tk.end - 4) / 65536;
    if (w >= 1 && h >= 1) return { w: Math.round(w), h: Math.round(h) };
  }
  throw new Error("Not an MP4 with a video track (only .mp4 files are supported).");
}

/** Load any image file/buffer as straight RGBA. Optionally resize (fit "fill" keeps exact size). */
export async function loadRgba(src: string | Buffer, resize?: { w: number; h: number }): Promise<{ w: number; h: number; rgba: Buffer }> {
  let p = sharp(src, { failOn: "none" }).ensureAlpha();
  if (resize) p = p.resize(resize.w, resize.h, { fit: "fill", kernel: "lanczos3" });
  const r = await p.raw().toBuffer({ resolveWithObject: true });
  return { w: r.info.width, h: r.info.height, rgba: r.data };
}
