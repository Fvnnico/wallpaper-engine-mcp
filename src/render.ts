import * as fs from "fs";
import * as path from "path";
import sharp, { OverlayOptions, Blend } from "sharp";
import { ASSETS } from "./effects";
import { texToRgba } from "./tex";
import { Obj, SceneCtx, kindOf, parseVec, sceneSize, worldXf, Xf, PT_PX, utilKind } from "./sceneio";

/* ---------------------------------------------------------------------
   Reading layer textures + a small compositor used by preview_scene.
   The compositor draws image/text layers with transform, alpha, tint and
   blend mode. Effects, particles and scripts are NOT simulated: they are
   only marked, so the preview shows layout, not motion.
   --------------------------------------------------------------------- */

export const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "")); } catch { return undefined; } };

/** Find a texture file ("name" -> materials/name.tex) in the project, then in WE assets. */
export function findTexFile(dir: string, name: string): string | undefined {
  for (const root of [dir, ASSETS]) {
    const p = path.join(root, "materials", name + ".tex");
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** model json -> material json -> first texture name -> .tex path */
export function layerTexFile(dir: string, obj: Obj): string | undefined {
  const img = typeof obj.image === "string" ? obj.image : undefined;
  if (!img) return undefined;
  const model = readJson(path.join(dir, img)) ?? readJson(path.join(ASSETS, img));
  const matPath = model?.material ?? (img.startsWith("materials/") ? img : undefined);
  if (!matPath) return undefined;
  const mat = readJson(path.join(dir, matPath)) ?? readJson(path.join(ASSETS, matPath));
  const tex = mat?.passes?.[0]?.textures?.[0];
  return typeof tex === "string" ? findTexFile(dir, tex) : undefined;
}

const texCache = new Map<string, { w: number; h: number; rgba: Buffer }>();

export async function layerTexture(dir: string, obj: Obj): Promise<{ w: number; h: number; rgba: Buffer } | null> {
  const f = layerTexFile(dir, obj);
  if (!f) return null;
  const key = f + ":" + fs.statSync(f).mtimeMs;
  if (!texCache.has(key)) { try { texCache.set(key, await texToRgba(fs.readFileSync(f))); } catch { return null; } }
  return texCache.get(key)!;
}

type Tex = { w: number; h: number; rgba: Buffer };

/** The `opacity` effect is just alpha * mask, so the preview applies it (vignettes, fades and soft shadows are built with it). */
async function withOpacityFx(dir: string, obj: Obj, tex: Tex): Promise<Tex> {
  for (const e of obj.effects ?? []) {
    if (!/(^|\/)opacity\/effect\.json$/.test(String(e.file)) || isHidden(e)) continue;
    const p = e.passes?.[0] ?? {};
    const a = num(p.constantshadervalues?.alpha, 1), ref = p.textures?.[1];
    const f = typeof ref === "string" ? path.join(dir, "materials", ref + ".tex") : "";
    const m = f && fs.existsSync(f) ? await texToRgba(fs.readFileSync(f)) : undefined;
    const w = m?.w ?? tex.w, h = m?.h ?? tex.h; // work at mask resolution
    const rgba = await sharp(tex.rgba, { raw: { width: tex.w, height: tex.h, channels: 4 } }).resize(w, h, { fit: "fill" }).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * a * (m ? m.rgba[i * 4] / 255 : 1));
    tex = { w, h, rgba };
  }
  return tex;
}

/* ---------------- drawing helpers ---------------- */

const BLEND: Record<number, Blend> = { 0: "over", 1: "darken", 2: "multiply", 3: "color-burn", 6: "lighten", 7: "screen", 8: "color-dodge", 9: "add", 11: "overlay", 12: "soft-light", 13: "hard-light", 18: "difference", 19: "exclusion" };

export interface Region { x: number; y: number; w: number; h: number }
export interface RenderOpts {
  /** canvas region to draw (px, top-left origin). Default: whole canvas */
  region?: Region;
  /** output width in px (default 1280) */
  width?: number;
  /** draw a coordinate grid every N canvas px (0 = none) */
  grid?: number;
  /** draw bounding boxes + ids */
  labels?: boolean;
  /** only draw these layers (ids); hidden layers are skipped anyway */
  only?: number[];
  /** tint the masks used by effects of these layers (ids) */
  masksOf?: number[];
}

export interface Rendered { png: Buffer; w: number; h: number; k: number; region: Region; notes: string[] }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function isHidden(o: Obj): boolean {
  const v = o.visible;
  if (v === false) return true;
  if (v && typeof v === "object" && "value" in v) return v.value === false;
  return false;
}
const num = (v: any, d: number) => (v && typeof v === "object" && "value" in v ? Number(v.value) : v === undefined ? d : Number(v));

async function placeRaster(rgba: Buffer, w: number, h: number, xf: Xf, size: number[], k: number, region: Region, canvasH: number, opts: { alpha?: number; tint?: number[]; blend?: Blend }): Promise<{ input: Buffer; left: number; top: number; blend: Blend } | null> {
  const bw = Math.max(1, Math.round(size[0] * Math.abs(xf.sx) * k)), bh = Math.max(1, Math.round(size[1] * Math.abs(xf.sy) * k));
  if (bw > 16000 || bh > 16000) return null;
  let img = sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).resize(bw, bh, { fit: "fill", kernel: "lanczos3" });
  if (xf.sx < 0 || xf.sy < 0) img = img.flop(xf.sx < 0).flip(xf.sy < 0);
  if (opts.tint || opts.alpha !== undefined && opts.alpha < 1) {
    const t = opts.tint ?? [1, 1, 1], a = opts.alpha ?? 1;
    img = img.ensureAlpha().recomb([[t[0], 0, 0, 0], [0, t[1], 0, 0], [0, 0, t[2], 0], [0, 0, 0, a]] as any);
  }
  if (Math.abs(xf.rot) > 1e-6) img = img.rotate(-xf.rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  const cx = (xf.x - region.x) * k, cy = (canvasH - xf.y - region.y) * k;
  return clipOverlay(data, info.width, info.height, Math.round(cx - info.width / 2), Math.round(cy - info.height / 2), Math.round(region.w * k), Math.round(region.h * k), opts.blend ?? "over");
}

/** Crop an overlay to the output canvas (sharp refuses overlays larger than the base). */
async function clipOverlay(png: Buffer, w: number, h: number, left: number, top: number, outW: number, outH: number, blend: Blend = "over"): Promise<{ input: Buffer; left: number; top: number; blend: Blend } | null> {
  const x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(outW, left + w), y1 = Math.min(outH, top + h);
  if (x1 <= x0 || y1 <= y0) return null;
  if (x0 === left && y0 === top && x1 - x0 === w && y1 - y0 === h) return { input: png, left, top, blend };
  return { input: await sharp(png).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer(), left: x0, top: y0, blend };
}

function gridSvg(w: number, h: number, region: Region, k: number, step: number): string {
  const lines: string[] = [];
  const fs = Math.max(10, Math.round(step * k * 0.18));
  const x0 = Math.ceil(region.x / step) * step, y0 = Math.ceil(region.y / step) * step;
  for (let x = x0; x <= region.x + region.w; x += step) {
    const px = (x - region.x) * k;
    lines.push(`<line x1="${px}" y1="0" x2="${px}" y2="${h}" stroke="#00e5ff" stroke-opacity="0.45" stroke-width="1"/>`);
    lines.push(`<text x="${px + 3}" y="${fs + 2}" font-size="${fs}" font-family="Arial" fill="#00e5ff" stroke="#000" stroke-width="2.5" paint-order="stroke">${x}</text>`);
  }
  for (let y = y0; y <= region.y + region.h; y += step) {
    const py = (y - region.y) * k;
    lines.push(`<line x1="0" y1="${py}" x2="${w}" y2="${py}" stroke="#ffea00" stroke-opacity="0.45" stroke-width="1"/>`);
    lines.push(`<text x="3" y="${py - 3}" font-size="${fs}" font-family="Arial" fill="#ffea00" stroke="#000" stroke-width="2.5" paint-order="stroke">${y}</text>`);
  }
  return lines.join("");
}

/** SVG grid overlay with labels in arbitrary units (used by inspect_image too). */
export function gridOverlay(w: number, h: number, region: Region, k: number, step: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${gridSvg(w, h, region, k, step)}</svg>`);
}

/** Pick a "nice" grid step so that roughly 8-14 lines are visible along the long side. */
export function niceStep(span: number): number {
  const raw = span / 10, pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}

export async function renderScene(ctx: SceneCtx, o: RenderOpts = {}): Promise<Rendered> {
  const { scene, dir } = ctx;
  const cv = sceneSize(scene);
  const region = o.region ?? { x: 0, y: 0, w: cv.w, h: cv.h };
  const outW = Math.max(64, Math.min(4096, Math.round(o.width ?? 1280)));
  const k = outW / region.w;
  const outH = Math.max(1, Math.round(region.h * k));
  const notes: string[] = [];
  const cc = parseVec(scene.general?.clearcolor, [0, 0, 0]).map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
  const layers: OverlayOptions[] = [];
  const objs: Obj[] = scene.objects;
  const labels: string[] = [];

  for (const obj of objs) {
    if (o.only && !o.only.includes(obj.id)) continue;
    const kind = kindOf(obj);
    let hiddenByParent = false;
    for (let p: Obj | undefined = obj; p; p = p.parent !== undefined ? objs.find(q => q.id === p!.parent) : undefined) if (isHidden(p)) hiddenByParent = true;
    if (hiddenByParent) continue;
    if (utilKind(obj) === "fullscreen") { notes.push(`[${obj.id}] ${obj.name}: full-canvas post-process layer (its effects are not previewed)`); continue; }
    const xf = worldXf(scene, obj);
    const size = parseVec(obj.size, [0, 0]);
    const tint = obj.color !== undefined ? parseVec(obj.color, [1, 1, 1]).slice(0, 3).map(v => v * num(obj.brightness, 1)) : (obj.brightness !== undefined ? Array(3).fill(num(obj.brightness, 1)) : undefined);
    const alpha = num(obj.alpha, 1);
    const blend = BLEND[num(obj.colorBlendMode, 0)] ?? "over";
    const pxc = (xf.x - region.x) * k, pyc = (cv.h - xf.y - region.y) * k;

    if (kind === "image") {
      const util = utilKind(obj);
      // a solid layer is a white pixel stretched to its size and tinted by `color`
      const tex = util === "solid" ? { w: 1, h: 1, rgba: Buffer.from([255, 255, 255, 255]) } : util ? null : await layerTexture(dir, obj);
      if (!tex) { notes.push(util ? `[${obj.id}] ${obj.name}: post-process layer (its effects are not previewed)` : `[${obj.id}] ${obj.name}: texture not found / not a still image (drawn as outline only)`); }
      else {
        const t = tint && tint.some(v => Math.abs(v - 1) > 1e-3) ? tint.map(v => Math.min(v, 4)) : undefined;
        const fxTex = await withOpacityFx(dir, obj, tex);
        const p = await placeRaster(fxTex.rgba, fxTex.w, fxTex.h, xf, size.length >= 2 ? size : [tex.w, tex.h], k, region, cv.h, { alpha: alpha < 1 ? alpha : undefined, tint: t, blend });
        if (p) layers.push(p);
      }
    } else if (kind === "text") {
      // WE: em = pointsize * PT_PX canvas px; origin is the anchor of the text (left edge / centre / right edge, vertically centred)
      const em = parseVec(obj.pointsize, [32])[0] * PT_PX * Math.abs(xf.sy) * k;
      const txt = typeof obj.text === "object" ? String(obj.text?.value ?? "") : String(obj.text ?? "");
      const col = parseVec(obj.color, [1, 1, 1]).slice(0, 3).map(v => Math.round(v * 255)).join(",");
      let lines = txt.split("\n");
      const maxw = num(obj.maxwidth, 0);
      if (obj.limitwidth && maxw > 0) {
        // ponytail: greedy wrap at ~0.46 em per character (Arial prose average); WE wraps on real glyph widths
        const maxChars = Math.max(1, Math.floor(maxw * Math.abs(xf.sx) * k / (0.46 * em)));
        lines = lines.flatMap(l => {
          const out: string[] = []; let cur = "";
          for (const w of l.split(" ")) { const t = cur ? `${cur} ${w}` : w; if (t.length > maxChars && cur) { out.push(cur); cur = w; } else cur = t; }
          return [...out, cur];
        });
      }
      const anchor = obj.horizontalalign === "left" ? "start" : obj.horizontalalign === "right" ? "end" : "middle";
      // the SVG is centred on the origin and wide enough for any line, so the text can never be clipped
      const W = Math.ceil(2 * Math.max(8 * em, ...lines.map(l => l.length * em))), H = Math.ceil((lines.length * 1.15 + 1) * em);
      const body = lines.map((l, i) => `<text x="${W / 2}" y="${H / 2 + (i - (lines.length - 1) / 2) * 1.15 * em + em * 0.35}" font-size="${em}" text-anchor="${anchor}" font-family="Arial" fill="rgb(${col})" fill-opacity="${alpha}">${esc(l)}</text>`).join("");
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`);
      try {
        let img = sharp(svg).ensureAlpha();
        if (Math.abs(xf.rot) > 1e-6) img = img.rotate(-xf.rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
        const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
        const p = await clipOverlay(data, info.width, info.height, Math.round(pxc - info.width / 2), Math.round(pyc - info.height / 2), outW, outH);
        if (p) layers.push(p);
      } catch { notes.push(`[${obj.id}] ${obj.name}: text could not be rasterised`); }
    }

    if (o.labels) {
      const col = kind === "image" ? "#ff4081" : kind === "particle" ? "#b2ff59" : kind === "text" ? "#ffd740" : "#40c4ff";
      const fx = Array.isArray(obj.effects) && obj.effects.length ? ` fx${obj.effects.length}` : "";
      if (kind === "image" && size.length >= 2) {
        const bw = size[0] * xf.sx * k, bh = size[1] * xf.sy * k;
        labels.push(`<g transform="translate(${pxc} ${pyc}) rotate(${-xf.rot})"><rect x="${-Math.abs(bw) / 2}" y="${-Math.abs(bh) / 2}" width="${Math.abs(bw)}" height="${Math.abs(bh)}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="8 5"/></g>`);
        labels.push(`<text x="${pxc + 4}" y="${pyc - Math.abs(bh) / 2 + 16}" font-size="15" font-family="Arial" fill="${col}" stroke="#000" stroke-width="3" paint-order="stroke">[${obj.id}] ${esc(String(obj.name ?? ""))}${fx}</text>`);
      } else {
        labels.push(`<circle cx="${pxc}" cy="${pyc}" r="7" fill="none" stroke="${col}" stroke-width="2"/><line x1="${pxc - 12}" y1="${pyc}" x2="${pxc + 12}" y2="${pyc}" stroke="${col}"/><line x1="${pxc}" y1="${pyc - 12}" x2="${pxc}" y2="${pyc + 12}" stroke="${col}"/>`);
        labels.push(`<text x="${pxc + 10}" y="${pyc - 8}" font-size="15" font-family="Arial" fill="${col}" stroke="#000" stroke-width="3" paint-order="stroke">[${obj.id}] ${kind}: ${esc(String(obj.name ?? ""))}</text>`);
      }
    }

    // mask overlay: tint the masks used by this layer's effects
    if (o.masksOf?.includes(obj.id) && kind === "image") {
      for (const e of obj.effects ?? []) for (const p of e.passes ?? []) for (const t of p.textures ?? []) {
        if (typeof t !== "string" || !t.startsWith("masks/")) continue;
        const f = path.join(dir, "materials", t + ".tex");
        if (!fs.existsSync(f)) continue;
        const m = await texToRgba(fs.readFileSync(f));
        const red = Buffer.alloc(m.w * m.h * 4);
        for (let i = 0; i < m.w * m.h; i++) { red[i * 4] = 255; red[i * 4 + 1] = 40; red[i * 4 + 2] = 40; red[i * 4 + 3] = Math.round(m.rgba[i * 4] * 0.55); }
        const p2 = await placeRaster(red, m.w, m.h, xf, size, k, region, cv.h, {});
        if (p2) layers.push(p2);
      }
    }
  }

  const base = sharp({ create: { width: outW, height: outH, channels: 3, background: { r: cc[0], g: cc[1], b: cc[2] } } });
  const overlays: OverlayOptions[] = [...layers];
  if (o.grid && o.grid > 0) overlays.push({ input: gridOverlay(outW, outH, region, k, o.grid), top: 0, left: 0 });
  if (labels.length) overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">${labels.join("")}</svg>`), top: 0, left: 0 });
  // composite in chunks: libvips handles many inputs, but keep memory sane
  let out = await base.png().toBuffer();
  for (let i = 0; i < overlays.length; i += 24) out = await sharp(out).composite(overlays.slice(i, i + 24)).png().toBuffer();
  return { png: out, w: outW, h: outH, k, region, notes };
}
