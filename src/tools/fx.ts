import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import sharp, { Sharp } from "sharp";
import {
  Obj, SceneCtx, openScene, saveScene, nextId, sceneSize, findLayer, parseVec, slug, worldXf, isPropSpec,
  bindProperty, bindable, kindOf, utilKind, colorStr,
} from "../sceneio";
import {
  loadEffect, loadWorkshopEffect, listBuiltinEffects, listWorkshopEffects, installWorkshopEffect, describeEffect, matchParam, formatValue,
  samplerFor, EffectInfo, BUILTIN_EFFECTS,
} from "../effects";
import { encodeTex } from "../tex";
import { layerTexture } from "../render";

/* ====================================================================
   Effect catalog
   ==================================================================== */

/** Short, practical notes for the effects that matter most (derived from shader parameters + real Workshop usage). */
const TIPS: Record<string, string> = {
  shake: "Jitter/vibration. Without a mask the whole layer shakes - give it an opacity mask for hair/cloth/sword only. strength 0.05-0.15, speed ~1. Direction map = masks.flow, time offset = masks.timeoffset.",
  waterwaves: "Wavy distortion; the best effect for hair/cloth/grass sway. The wave travels along `direction` (radians or \"90deg\") and pixels move PERPENDICULAR to it, along (cos direction, sin direction) in image space (y down): 0 or 180deg = vertical strands sway sideways, 90deg = horizontal bobbing. REACH = strength² x LAYER size in px (measured): strength 0.1 on a 2560 px wide layer = 26 px, 0.2 = 100 px. Aim for 3-10 px on hair/cloth: strength ~0.04-0.08 on a full-canvas layer, 0.15-0.3 only on small strand layers (the tool prints the peak px). `scale` = phase per layer width (UV): on a big layer 3 is nearly uniform over a head, ~10-30 puts a wave along a cloth. speed 1.5-3 is a calm sway, 5-8 a flutter (too fast on a person). exponent 1. One effect per strand/layer with slightly different speed/direction. Always give it an opacity mask (only the free-hanging part, NOT faces/eyes) and a timeoffset mask (gradient root=0 -> tip=1) so the phase flows along the strand. Defaults (scale 200, strength 0.1) are for fine water ripples / heat haze.",
  swing: "Pendulum-style rotation about the axis between point0 and point1 (normalised to the layer, 0..1, y up). amount 0.05-0.2, speed 1-2. Good for hanging things; a mask limits it.",
  pulse: "Pulses alpha/colour (PULSEALPHA/PULSECOLOR combos). speed 1-3, amount 0..1. Good for glowing parts with a mask; AUDIOPROCESSING=1 makes it react to music.",
  foliagesway: "Wind sway for plants/hair/cloth: strength ~0.4, speeduv ~5, scale ~0.05. Use a mask to pin the root.",
  scroll: "Scrolls the layer texture (clouds, fog, rain streaks, speed lines). speedx/speedy typically -0.5..0.5. The texture must repeat: add the layer with add_layer tile:true and a seamless image, otherwise it just slides away.",
  cloudmotion: "Slow organic cloud/smoke motion (amount ~0.05, speed ~0.025).",
  godrays: "Radial light rays from `center` (0..1). rayintensity 0.3-1, raylength 0.5, raythreshold 0.4.",
  lightshafts: "Shaft/beam lighting; usually used on a quad layer (use add_particles preset 'lightshafts/...').",
  tint: "Colour tint (color + alpha). Combine with a mask for local colour.",
  opacity: "Layer opacity (alpha) - mask-able; use it to hide parts of a layer.",
  blur: "Blur (scale 1-4). Several variants: blurprecise, blurradial, motionblur.",
  twirl: "Swirl distortion around `center` (0..1). amount 0.1, size 0.3.",
  depthparallax: "2.5D parallax from a depth map: needs the camera parallax in the scene (scene_settings parallax.enabled).",
  iris: "Animated eye/iris ring (noise, speed). Needs a mask on the eye.",
  shimmer: "Moving glints across the layer.",
  nitro: "Flowing neon/energy lines along edges.",
  chromaticaberration: "RGB channel split (lens look).",
  filmgrain: "Film grain overlay.",
  vhs: "VHS tape distortion.",
};

function effectLine(e: EffectInfo): string {
  const keys = e.params.filter(p => !/^audio|^frequency/.test(p.key)).slice(0, 7).map(p => p.key).join(", ");
  return `  ${e.ref} - "${e.title}" [${e.group || "-"}] ${e.passCount > 1 ? `${e.passCount} passes, ` : ""}params: ${keys || "-"}${e.samplers.some(s => s.role === "opacity") ? " | mask-able" : ""}`;
}

export function listEffectsTool(a: { query?: string; effect?: string; source?: "builtin" | "workshop" | "all"; project?: string }): string {
  const projectDir = a.project ? safeProjectDir(a.project) : undefined;
  if (a.effect) {
    const info = findEffectInfo(a.effect, projectDir);
    if (!info) return `Effect "${a.effect}" not found. Call list_effects without "effect" to browse. Workshop effects: "workshop/<itemId>/<name>".`;
    const tip = TIPS[info.ref.split("/").pop()!];
    return describeEffect(info) + (tip ? `\n  Tip: ${tip}` : "");
  }
  const q = a.query?.toLowerCase();
  const match = (...s: string[]) => !q || s.some(x => x.toLowerCase().includes(q));
  const out: string[] = [];
  if (a.source !== "workshop") {
    const list = listBuiltinEffects().filter(e => match(e.ref, e.title, e.group, e.description));
    out.push(`Built-in effects (${list.length}) - name goes in add_effect; call list_effects with effect:"<name>" for every parameter:`);
    const groups = new Map<string, EffectInfo[]>();
    for (const e of list) (groups.get(e.group || "other") ?? groups.set(e.group || "other", []).get(e.group || "other")!).push(e);
    for (const [g, es] of groups) { out.push(`[${g}]`); es.forEach(e => out.push(effectLine(e))); }
  }
  if (a.source !== "builtin") {
    const ws = listWorkshopEffects().filter(w => match(w.title, w.id, ...w.effects));
    out.push(ws.length ? `Installed Workshop effects (${ws.length}) - use "workshop/<itemId>/<name>"; they are copied into the project automatically:` : "No Workshop effects found in the local Workshop folder.");
    for (const w of ws) out.push(`  ${w.id} "${w.title}": ${w.effects.map(n => `workshop/${w.id}/${n}`).join(", ")}`);
  }
  return out.join("\n");
}

function safeProjectDir(project: string): string | undefined {
  try { return openScene(project).dir; } catch { return undefined; }
}

/** Resolve an effect reference: built-in ("shake"), project-local, or Workshop ("workshop/<id>/<name>" / "<id>/<name>"). */
export function findEffectInfo(ref: string, projectDir?: string): EffectInfo | null {
  const direct = loadEffect(ref, projectDir);
  if (direct) return direct;
  const m = /^(?:workshop[:/])?(\d{6,})[:/]([\w.-]+)$/.exec(ref.trim());
  if (m) return loadWorkshopEffect(m[1], m[2]);
  // bare Workshop effect name
  const hits = listWorkshopEffects().flatMap(w => w.effects.filter(n => n.toLowerCase() === ref.toLowerCase()).map(n => ({ id: w.id, n })));
  if (hits.length === 1) return loadWorkshopEffect(hits[0].id, hits[0].n);
  return null;
}

function copyMissing(from: string, to: string) {
  if (fs.statSync(from).isDirectory()) {
    for (const f of fs.readdirSync(from)) copyMissing(path.join(from, f), path.join(to, f));
  } else if (!fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
}

/** Do what the editor does when an effect is first used: copy its definition, materials and shaders into the project. */
export function installEffect(dir: string, info: EffectInfo): EffectInfo {
  if (info.builtin) {
    const src = path.join(BUILTIN_EFFECTS, info.ref);
    for (const f of fs.readdirSync(src)) if (f !== "preview") copyMissing(path.join(src, f), f === "effect.json" ? path.join(dir, "effects", info.ref, f) : path.join(dir, f));
    return info;
  }
  const m = /^workshop\/(\d+)\/(.+)$/.exec(info.ref);
  if (m && !fs.existsSync(path.join(dir, "effects", info.ref, "effect.json"))) {
    installWorkshopEffect(dir, m[1], m[2]);
    return loadEffect(info.ref, dir) ?? info;
  }
  return loadEffect(info.ref, dir) ?? info;
}

/* ====================================================================
   Masks
   ==================================================================== */

export type Shape =
  | { type: "rect"; x: number; y: number; w: number; h: number; radius?: number; rotation?: number; value?: number; feather?: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry?: number; rotation?: number; value?: number; feather?: number }
  | { type: "polygon"; points: number[][]; value?: number; feather?: number }
  | { type: "path"; d: string; value?: number; feather?: number }
  | { type: "gradient"; from: number[]; to: number[]; from_value?: number; to_value?: number }
  | { type: "radial"; cx: number; cy: number; r: number; inner?: number; value?: number };

export interface MaskSpec {
  /** existing project mask ("masks/<name>") or absolute image path (white = effect fully on) */
  image?: string;
  /** use the layer's own alpha (its silhouette) as the mask */
  from_layer?: boolean;
  shapes?: Shape[];
  /** starting level 0..1 under the shapes (0 = effect off everywhere, default) */
  base?: number;
  invert?: boolean;
  /** Gaussian blur in mask px, softens the whole mask */
  blur?: number;
  channel?: "luma" | "alpha";
  /** coordinates of shapes: "canvas" (px of the scene canvas, top-left origin - same as get_scene/preview_scene; default) or "layer" (texture px of the layer) */
  space?: "canvas" | "layer";
  /** max side of the generated mask in px (default 2048) */
  resolution?: number;
  name?: string;
  /** key the source pixels (`image`, else the layer's own texture) by colour: on within `tolerance` (0..1 of the RGB range, default 0.15), fading out over `softness` (default 0.1); transparent pixels never match */
  color?: { color: string | number[]; tolerance?: number; softness?: number };
  /** binarise the source level (colour key, from_layer alpha, image luma/alpha): on at or above this level 0..1 */
  threshold?: number;
  /** after the shapes: grow (+) or shrink (-) the active area by N mask px (binarised at 50%), then fade out over `falloff` mask px beyond its edge (exact distance, unlike blur) */
  grow?: number;
  falloff?: number;
  /** more masks merged in at the same size, in order: add = max, subtract = a x (1 - b), intersect = min. Applied before blur and invert */
  combine?: (Omit<MaskSpec, "combine"> & { op: "add" | "subtract" | "intersect" })[];
}

/** Distance in px (chamfer 3-4, within ~8%) from every pixel to the nearest pixel with level >= 128 (0 for those); a mask without any such pixel gets 1e9/3. */
function distToOn(lv: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = lv[i] >= 128 ? 0 : 1e9;
  const at = (x: number, y: number, add: number, cur: number) => (x < 0 || y < 0 || x >= w || y >= h ? cur : Math.min(cur, d[y * w + x] + add));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = d[y * w + x];
    v = at(x - 1, y, 3, v); v = at(x, y - 1, 3, v); v = at(x - 1, y - 1, 4, v); v = at(x + 1, y - 1, 4, v);
    d[y * w + x] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    let v = d[y * w + x];
    v = at(x + 1, y, 3, v); v = at(x, y + 1, 3, v); v = at(x + 1, y + 1, 4, v); v = at(x - 1, y + 1, 4, v);
    d[y * w + x] = v;
  }
  return d.map(v => v / 3);
}

/** grow (n > 0) or shrink (n < 0) the active area by |n| px; the result is binary */
function growMask(lv: Uint8Array, w: number, h: number, n: number): Uint8Array {
  const out = new Uint8Array(w * h);
  if (n >= 0) { const d = distToOn(lv, w, h); for (let i = 0; i < out.length; i++) out[i] = d[i] <= n ? 255 : 0; }
  else { const d = distToOn(lv.map(v => 255 - v), w, h); for (let i = 0; i < out.length; i++) out[i] = lv[i] >= 128 && d[i] > -n ? 255 : 0; }
  return out;
}

/** keep the active area and fade it out smoothly over `f` px beyond its edge */
function falloffMask(lv: Uint8Array, w: number, h: number, f: number): Uint8Array {
  const d = distToOn(lv, w, h), out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) { const t = Math.max(0, 1 - d[i] / f); out[i] = d[i] === 0 ? lv[i] : Math.round(255 * t * t * (3 - 2 * t)); }
  return out;
}

const f4 = (n: number) => (+n).toFixed(4).replace(/\.?0+$/, "");
const grey = (v: number) => { const g = Math.round(Math.max(0, Math.min(1, v)) * 255); return `rgb(${g},${g},${g})`; };

function shapesSvg(shapes: Shape[], matrix: string): string {
  const defs: string[] = [], body: string[] = [];
  shapes.forEach((s, i) => {
    const filt = "feather" in s && s.feather && s.feather > 0 ? ` filter="url(#f${i})"` : "";
    if (filt) defs.push(`<filter id="f${i}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${f4((s as any).feather / 2)}"/></filter>`);
    const v = "value" in s && s.value !== undefined ? s.value : 1;
    switch (s.type) {
      case "rect": body.push(`<rect x="${f4(s.x)}" y="${f4(s.y)}" width="${f4(s.w)}" height="${f4(s.h)}" rx="${f4(s.radius ?? 0)}" fill="${grey(v)}"${s.rotation ? ` transform="rotate(${-s.rotation} ${f4(s.x + s.w / 2)} ${f4(s.y + s.h / 2)})"` : ""}${filt}/>`); break;
      case "ellipse": body.push(`<ellipse cx="${f4(s.cx)}" cy="${f4(s.cy)}" rx="${f4(s.rx)}" ry="${f4(s.ry ?? s.rx)}" fill="${grey(v)}"${s.rotation ? ` transform="rotate(${-s.rotation} ${f4(s.cx)} ${f4(s.cy)})"` : ""}${filt}/>`); break;
      case "polygon": body.push(`<polygon points="${s.points.map(p => `${f4(p[0])},${f4(p[1])}`).join(" ")}" fill="${grey(v)}"${filt}/>`); break;
      case "path": body.push(`<path d="${s.d.replace(/"/g, "")}" fill="${grey(v)}"${filt}/>`); break;
      case "gradient":
        defs.push(`<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${f4(s.from[0])}" y1="${f4(s.from[1])}" x2="${f4(s.to[0])}" y2="${f4(s.to[1])}"><stop offset="0" stop-color="${grey(s.from_value ?? 0)}"/><stop offset="1" stop-color="${grey(s.to_value ?? 1)}"/></linearGradient>`);
        body.push(`<rect x="-100000" y="-100000" width="200000" height="200000" fill="url(#g${i})"/>`); break;
      case "radial": {
        const inner = Math.max(0, Math.min(0.99, s.inner ?? 0));
        defs.push(`<radialGradient id="g${i}" gradientUnits="userSpaceOnUse" cx="${f4(s.cx)}" cy="${f4(s.cy)}" r="${f4(s.r)}"><stop offset="${inner}" stop-color="${grey(v)}"/><stop offset="1" stop-color="${grey(0)}"/></radialGradient>`);
        body.push(`<circle cx="${f4(s.cx)}" cy="${f4(s.cy)}" r="${f4(s.r)}" fill="url(#g${i})"/>`); break;
      }
    }
  });
  return `<defs>${defs.join("")}</defs><g transform="${matrix}">${body.join("")}</g>`;
}

/** Build a greyscale mask (RGBA buffer, R = level) in the texture space of `layer` (or the canvas when no layer). */
export async function buildMask(ctx: SceneCtx, layer: Obj | undefined, spec: MaskSpec): Promise<{ rgba: Buffer; w: number; h: number }> {
  const cv = sceneSize(ctx.scene);
  const nat = layer ? parseVec(layer.size, [cv.w, cv.h]) : [cv.w, cv.h];
  const res = Math.max(16, Math.min(4096, spec.resolution ?? 2048));
  const k = Math.min(1, res / Math.max(nat[0], nat[1]));
  const mw = Math.max(1, Math.round(nat[0] * k)), mh = Math.max(1, Math.round(nat[1] * k));
  const base = Math.round(Math.max(0, Math.min(1, spec.base ?? 0)) * 255);

  // one grey byte per pixel, whatever band layout sharp hands back
  const grey1 = async (s: Sharp): Promise<Buffer> => {
    const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
    const g = Buffer.alloc(info.width * info.height);
    for (let i = 0; i < g.length; i++) g[i] = data[i * info.channels];
    return g;
  };
  const imagePath = () => {
    const p = spec.image!.startsWith("masks/") ? path.join(ctx.dir, "materials", spec.image + ".png") : spec.image!;
    if (!fs.existsSync(p)) throw new Error(`Mask image not found: "${spec.image}".`);
    return p;
  };
  const layerRgba = async () => {
    if (!layer) throw new Error("This mask source needs a layer.");
    const t = await layerTexture(ctx.dir, layer);
    if (!t) throw new Error(`Layer "${layer.name}" has no readable texture.`);
    return sharp(t.rgba, { raw: { width: t.w, height: t.h, channels: 4 } }).resize(mw, mh, { fit: "fill" });
  };
  let g: Buffer;
  if (spec.color) {
    const [kr, kg, kb] = colorStr(spec.color.color).split(" ").map(Number), tol = spec.color.tolerance ?? 0.15, soft = Math.max(1e-3, spec.color.softness ?? 0.1);
    const px = await (spec.image ? sharp(imagePath(), { failOn: "none" }).ensureAlpha().resize(mw, mh, { fit: "fill" }) : await layerRgba()).raw().toBuffer();
    g = Buffer.alloc(mw * mh);
    for (let i = 0; i < g.length; i++) {
      const dist = Math.hypot(px[i * 4] / 255 - kr, px[i * 4 + 1] / 255 - kg, px[i * 4 + 2] / 255 - kb) / Math.sqrt(3);
      g[i] = Math.round(255 * Math.max(0, Math.min(1, 1 - (dist - tol) / soft)) * px[i * 4 + 3] / 255);
    }
  } else if (spec.from_layer) g = await grey1((await layerRgba()).extractChannel(3));
  else if (spec.image) {
    const s = sharp(imagePath(), { failOn: "none" }).resize(mw, mh, { fit: "fill" });
    g = await grey1(spec.channel === "alpha" ? s.ensureAlpha().extractChannel(3) : s.flatten({ background: "#000" }).greyscale());
  } else g = Buffer.alloc(mw * mh, base);
  if (spec.threshold !== undefined) for (let i = 0; i < g.length; i++) g[i] = g[i] >= spec.threshold * 255 ? 255 : 0;
  let rgba = Buffer.alloc(mw * mh * 4, 255);
  for (let i = 0; i < g.length; i++) { rgba[i * 4] = g[i]; rgba[i * 4 + 1] = g[i]; rgba[i * 4 + 2] = g[i]; }

  if (spec.shapes?.length) {
    let matrix: string;
    // a full-canvas post-process layer has no transform: its texture space IS the canvas
    if ((spec.space ?? "canvas") === "layer" || !layer || utilKind(layer) === "fullscreen") matrix = `matrix(${f4(k)} 0 0 ${f4(k)} 0 0)`;
    else {
      // canvas px -> layer texture px -> mask px (inverse of the layer's world transform)
      const w = worldXf(ctx.scene, layer), r = w.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      const sx = w.sx || 1, sy = w.sy || 1;
      // forward: [X;Y] = M [a;b] + T, M = [[c*sx, s*sy], [-s*sx, c*sy]], T = (cx, H-cy), (a,b) = (u-w/2, v-h/2)
      const det = (c * sx) * (c * sy) + (s * sy) * (s * sx);
      const i11 = (c * sy) / det, i12 = -(s * sy) / det, i21 = (s * sx) / det, i22 = (c * sx) / det;
      const Tx = w.x, Ty = cv.h - w.y;
      const e = -i11 * Tx - i12 * Ty + nat[0] / 2, f = -i21 * Tx - i22 * Ty + nat[1] / 2;
      matrix = `matrix(${f4(k * i11)} ${f4(k * i21)} ${f4(k * i12)} ${f4(k * i22)} ${f4(k * e)} ${f4(k * f)})`;
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${mw}" height="${mh}" viewBox="0 0 ${mw} ${mh}">${shapesSvg(spec.shapes, matrix)}</svg>`);
    rgba = (await sharp(rgba, { raw: { width: mw, height: mh, channels: 4 } }).composite([{ input: svg }]).raw().toBuffer({ resolveWithObject: true })).data;
  }
  if (spec.grow || spec.falloff || spec.combine?.length) {
    let lv: Uint8Array = Buffer.alloc(mw * mh);
    for (let i = 0; i < lv.length; i++) lv[i] = rgba[i * 4];
    if (spec.grow) lv = growMask(lv, mw, mh, spec.grow);
    if (spec.falloff && spec.falloff > 0) lv = falloffMask(lv, mw, mh, spec.falloff);
    for (const c of spec.combine ?? []) {
      const o = (await buildMask(ctx, layer, { ...c, resolution: spec.resolution })).rgba;
      for (let i = 0; i < lv.length; i++) lv[i] = c.op === "add" ? Math.max(lv[i], o[i * 4]) : c.op === "subtract" ? Math.round(lv[i] * (1 - o[i * 4] / 255)) : Math.min(lv[i], o[i * 4]);
    }
    for (let i = 0; i < lv.length; i++) { rgba[i * 4] = lv[i]; rgba[i * 4 + 1] = lv[i]; rgba[i * 4 + 2] = lv[i]; }
  }
  let img = sharp(rgba, { raw: { width: mw, height: mh, channels: 4 } });
  if (spec.blur && spec.blur > 0.3) img = img.blur(spec.blur);
  if (spec.invert) img = img.negate({ alpha: false });
  rgba = (await img.raw().toBuffer({ resolveWithObject: true })).data;
  // make alpha opaque so the red channel is the level
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { rgba, w: mw, h: mh };
}

function maskStats(rgba: Buffer) {
  let sum = 0, on = 0; const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) { sum += rgba[i]; if (rgba[i] > 127) on++; }
  return { mean: sum / n / 255, coverage: on / n };
}

/** Create the mask files (.tex/.png/.tex-json) like the editor and return "masks/<name>". */
export async function createMaskFiles(ctx: SceneCtx, layer: Obj | undefined, spec: MaskSpec, effectName: string): Promise<{ ref: string; w: number; h: number; coverage: number }> {
  if (spec.image && spec.image.startsWith("masks/") && !spec.shapes && !spec.invert && !spec.blur && !spec.color && !spec.grow && !spec.falloff && spec.threshold === undefined && !spec.combine?.length && fs.existsSync(path.join(ctx.dir, "materials", spec.image + ".tex")))
    return { ref: spec.image, w: 0, h: 0, coverage: NaN };
  const m = await buildMask(ctx, layer, spec);
  const png = await sharp(m.rgba, { raw: { width: m.w, height: m.h, channels: 4 } }).extractChannel(0).png().toBuffer();
  const hash = crypto.createHash("sha1").update(png).digest("hex").slice(0, 8);
  const name = spec.name ? slug(spec.name) : `${slug(effectName)}_mask_${hash}`;
  const dir = path.join(ctx.dir, "materials", "masks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + ".tex"), await encodeTex(m.rgba, m.w, m.h, { format: "r8" }));
  fs.writeFileSync(path.join(dir, name + ".png"), png);
  fs.writeFileSync(path.join(dir, name + ".tex-json"), JSON.stringify({ clampuvs: true, format: "r8", nomip: true, nonpoweroftwo: true }, null, "\t"));
  return { ref: `masks/${name}`, w: m.w, h: m.h, coverage: maskStats(m.rgba).coverage };
}

export async function createMask(project: string, a: MaskSpec & { layer?: string | number; name: string }): Promise<string> {
  const ctx = openScene(project);
  const layer = a.layer !== undefined ? findLayer(ctx.scene, a.layer) : undefined;
  const r = await createMaskFiles(ctx, layer, a, a.name);
  return [
    `Mask "${r.ref}" written (${r.w}x${r.h}, R8${Number.isFinite(r.coverage) ? `, ${(r.coverage * 100).toFixed(1)}% of the area active` : ""}).`,
    layer ? `Mapped to layer [${layer.id}] "${layer.name}" (${(a.space ?? "canvas")} coordinates).` : "No layer given: mapped to the whole canvas.",
    `Use it in add_effect / update_effect: masks: { opacity: "${r.ref}" } (or flow / timeoffset for effects that have those slots).`,
    "Check it visually with preview_scene { masks_of: [layer] } before applying.",
  ].join("\n");
}

/* ====================================================================
   Effect entries on layers
   ==================================================================== */

export interface EffectOpts {
  values?: Record<string, any>;
  combos?: Record<string, any>;
  masks?: { opacity?: MaskSpec | string; flow?: MaskSpec | string; timeoffset?: MaskSpec | string };
  textures?: Record<string, string>;
  name?: string;
  visible?: any;
}

function passTexArray(pass: any): (string | null)[] { pass.textures = Array.isArray(pass.textures) ? pass.textures : []; return pass.textures; }

async function fillEntry(ctx: SceneCtx, layer: Obj, info: EffectInfo, entry: any, o: EffectOpts, warn: string[]): Promise<string[]> {
  const done: string[] = [];
  const passOf = (i: number) => entry.passes[i];
  // values
  const unknown: string[] = [];
  for (const [key, raw] of Object.entries(o.values ?? {})) {
    const p = matchParam(info, key);
    if (!p) { unknown.push(key); continue; }
    for (const q of info.params.filter(x => x.key === p.key)) {
      let v = raw;
      if (isPropSpec(v)) {
        const spec = { ...v, type: v.type ?? (q.color ? "color" : undefined), value: v.value !== undefined ? v.value : q.default };
        v = bindProperty(ctx.dir, spec as any, q.default);
      } else if (v && typeof v === "object" && !Array.isArray(v) && "animation" in v) { /* pass through */ }
      else {
        v = formatValue(q, v);
        if (typeof v === "number" && q.range && (v < q.range[0] - 1e-9 || v > q.range[1] + 1e-9)) warn.push(`${q.key}=${v} is outside the editor range ${q.range[0]}..${q.range[1]} (allowed, but check the result).`);
      }
      const pass = passOf(q.pass); pass.constantshadervalues = pass.constantshadervalues ?? {};
      pass.constantshadervalues[q.key] = v;
    }
    done.push(`${p.key}=${JSON.stringify(raw)}`);
  }
  if (unknown.length) throw new Error(`Unknown parameter(s) for ${info.ref}: ${unknown.join(", ")}. Valid keys: ${info.params.map(p => p.key).join(", ")}.`);

  // combos
  for (const [key, raw] of Object.entries(o.combos ?? {})) {
    const c = info.combos.find(x => x.combo.toLowerCase() === key.toLowerCase());
    if (!c) throw new Error(`Unknown combo "${key}" for ${info.ref}. Valid: ${info.combos.map(x => x.combo).join(", ") || "none"}.`);
    let v: number;
    if (typeof raw === "boolean") v = raw ? 1 : 0;
    else if (typeof raw === "string" && c.options) {
      const hit = Object.entries(c.options).find(([n]) => n.toLowerCase().replace(/^ui_editor_properties_/, "").replace(/_/g, "") === raw.toLowerCase().replace(/[ _]/g, ""));
      if (!hit) throw new Error(`Combo ${c.combo} options: ${Object.entries(c.options).map(([n, x]) => `${n.replace(/^ui_editor_properties_/, "")}=${x}`).join(", ")}.`);
      v = hit[1];
    } else v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`Combo ${c.combo} needs a number.`);
    const pass = passOf(c.pass); pass.combos = pass.combos ?? {}; pass.combos[c.combo] = v;
    done.push(`combo ${c.combo}=${v}`);
  }

  // masks
  for (const role of ["opacity", "flow", "timeoffset"] as const) {
    const m = o.masks?.[role];
    if (m === undefined) continue;
    const s = samplerFor(info, role);
    if (!s) { warn.push(`${info.ref} has no "${role}" mask slot - ignored.`); continue; }
    const spec: MaskSpec = typeof m === "string" ? (m.startsWith("masks/") ? { image: m } : { image: m, space: "layer" }) : m;
    const r = await createMaskFiles(ctx, layer, spec, info.ref.split("/").pop()!);
    const arr = passTexArray(passOf(s.pass));
    while (arr.length <= s.slot) arr.push(null);
    arr[s.slot] = r.ref;
    done.push(`${role} mask -> slot ${s.slot} (${r.ref}${Number.isFinite(r.coverage) ? `, ${(r.coverage * 100).toFixed(0)}% active` : ""})`);
    if (Number.isFinite(r.coverage) && r.coverage < 0.002) warn.push(`The ${role} mask is almost empty - the effect will be invisible. Check the shape coordinates (default space: canvas px).`);
  }
  for (const [slot, ref] of Object.entries(o.textures ?? {})) {
    const i = Number(slot);
    const s = info.samplers.find(x => x.slot === i);
    const arr = passTexArray(passOf(s?.pass ?? 0));
    while (arr.length <= i) arr.push(null);
    arr[i] = ref; done.push(`texture slot ${i} = ${ref}`);
  }
  if (o.name !== undefined) { entry.name = o.name; done.push(`name=${o.name}`); }
  if (o.visible !== undefined) { entry.visible = bindable(ctx.dir, o.visible, true); done.push("visible"); }
  if (info.ref.endsWith("waterwaves")) {
    // measured in WE: pixels move by strength² x layer size along (cos a, sin a) (image px, y down), i.e. the unit that matters is the layer size, not the strength
    const val = (k: string, d: number) => { for (const p of entry.passes) { const v = p.constantshadervalues?.[k]; const n = v && typeof v === "object" ? v.value : v; if (n !== undefined && Number.isFinite(+n)) return +n; } return d; };
    const sz = parseVec(layer.size, [0, 0]), xf = worldXf(ctx.scene, layer), w = Math.abs(sz[0] * xf.sx), h = Math.abs(sz[1] * xf.sy);
    const s2 = val("strength", 0.1) ** 2, a = val("direction", 0), dx = s2 * w * Math.abs(Math.cos(a)), dy = s2 * h * Math.abs(Math.sin(a));
    if (w && h) {
      done.push(`peak displacement ~${dx.toFixed(0)} px sideways + ${dy.toFixed(0)} px vertical (strength² x layer size ${w.toFixed(0)}x${h.toFixed(0)})`);
      if (Math.hypot(dx, dy) > 25) warn.push(`waterwaves moves pixels up to ${Math.hypot(dx, dy).toFixed(0)} px here: far too much for hair/cloth (3-10 px). Strength is squared and relative to the LAYER size: a full-canvas layer needs ~0.04-0.08, the 0.15-0.3 of hand-made recipes belong to small strand layers.`);
    }
  }
  return done;
}

export function effectLabel(e: any): string {
  return String(e.file ?? "").replace(/^effects\//, "").replace(/\/effect\.json$/, "");
}

export function findEntry(layer: Obj, ref: string | number): number {
  const list: any[] = layer.effects ?? [];
  if (!list.length) throw new Error(`Layer "${layer.name}" has no effects.`);
  if (typeof ref === "number") { if (ref < 0 || ref >= list.length) throw new Error(`Effect index ${ref} out of range (0..${list.length - 1}).`); return ref; }
  const s = String(ref).trim();
  if (/^#?\d+$/.test(s)) return findEntry(layer, Number(s.replace("#", "")));
  const low = s.toLowerCase();
  const byName = list.map((e, i) => ({ e, i })).filter(x => String(x.e.name ?? "").toLowerCase() === low);
  const byFile = list.map((e, i) => ({ e, i })).filter(x => effectLabel(x.e).toLowerCase() === low || effectLabel(x.e).toLowerCase().endsWith("/" + low));
  const hit = byName.length ? byName : byFile;
  if (hit.length === 1) return hit[0].i;
  throw new Error(hit.length ? `"${ref}" matches ${hit.length} effects (${hit.map(x => "#" + x.i).join(", ")}). Use the index.` : `Effect "${ref}" not found on "${layer.name}". Present: ${list.map((e, i) => `#${i} ${effectLabel(e)}`).join(", ")}.`);
}

function summarize(layer: Obj): string {
  return (layer.effects ?? []).map((e: any, i: number) => `#${i} ${effectLabel(e)}${e.name ? ` "${e.name}"` : ""}`).join(", ");
}

export async function addEffect(project: string, layer: string | number, effect: string, o: EffectOpts & { position?: "start" | "end" | number }): Promise<string> {
  const ctx = openScene(project);
  const obj = findLayer(ctx.scene, layer);
  const kind = kindOf(obj);
  if (!["image", "shape", "text", "particle", "model"].includes(kind) && kind !== "group") throw new Error(`Layer "${obj.name}" (${kind}) cannot have effects.`);
  const found = findEffectInfo(effect, ctx.dir);
  if (!found) throw new Error(`Effect "${effect}" not found. Use list_effects (query) to search; Workshop effects: "workshop/<itemId>/<name>".`);
  if (!found.passCount) throw new Error(`Effect "${effect}" has no passes.`);
  const info = installEffect(ctx.dir, found);
  let id = nextId(ctx.scene);
  const entry: any = { file: info.file, id: id++, name: o.name ?? "", passes: [], visible: true };
  for (let i = 0; i < info.passCount; i++) entry.passes.push({ id: id++ });
  const warn: string[] = [];
  const done = await fillEntry(ctx, obj, info, entry, o, warn);
  obj.effects = Array.isArray(obj.effects) ? obj.effects : [];
  const at = o.position === "start" ? 0 : typeof o.position === "number" ? Math.max(0, Math.min(obj.effects.length, o.position)) : obj.effects.length;
  obj.effects.splice(at, 0, entry);
  saveScene(ctx);
  const tip = TIPS[info.ref.split("/").pop()!];
  return [
    `Added effect "${info.ref}" as #${at} on [${obj.id}] "${obj.name}". Stack: ${summarize(obj)}`,
    done.length ? `Set: ${done.join("; ")}` : "Using the effect's default parameters (call list_effects effect:\"" + info.ref + "\" for the keys).",
    ...warn.map(w => "WARNING: " + w),
    tip ? `Tip: ${tip}` : "",
  ].filter(Boolean).join("\n");
}

export async function updateEffect(project: string, layer: string | number, effect: string | number, o: EffectOpts & { move_to?: number }): Promise<string> {
  const ctx = openScene(project);
  const obj = findLayer(ctx.scene, layer);
  const idx = findEntry(obj, effect);
  const entry = obj.effects[idx];
  const info = findEffectInfo(effectLabel(entry), ctx.dir);
  if (!info) throw new Error(`Cannot read the definition of ${entry.file}; is the effect file still in the project?`);
  const warn: string[] = [];
  const done = await fillEntry(ctx, obj, info, entry, o, warn);
  if (o.move_to !== undefined) {
    obj.effects.splice(idx, 1);
    obj.effects.splice(Math.max(0, Math.min(obj.effects.length, o.move_to)), 0, entry);
    done.push(`moved to #${obj.effects.indexOf(entry)}`);
  }
  if (!done.length) return "Nothing to change.";
  saveScene(ctx);
  return [`Updated effect #${idx} (${info.ref}) on [${obj.id}] "${obj.name}": ${done.join("; ")}`, `Stack: ${summarize(obj)}`, ...warn.map(w => "WARNING: " + w)].join("\n");
}

export function removeEffect(project: string, layer: string | number, effect: string | number): string {
  const ctx = openScene(project);
  const obj = findLayer(ctx.scene, layer);
  const idx = findEntry(obj, effect);
  const [gone] = obj.effects.splice(idx, 1);
  if (!obj.effects.length) delete obj.effects;
  saveScene(ctx);
  return `Removed effect #${idx} (${effectLabel(gone)}) from [${obj.id}] "${obj.name}". Remaining: ${summarize(obj) || "none"}`;
}
