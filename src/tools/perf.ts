import * as fs from "fs";
import * as path from "path";
import { ASSETS, loadEffect } from "../effects";
import { findTexFile, isHidden, layerTexFile, readJson } from "../render";
import { Obj, kindOf, parseVec, utilKind, worldXf } from "../sceneio";
import { TEX_DXT5, TEX_FORMAT_NAMES, TEX_RGBA8888, texBytes, texHeader } from "../tex";

/*
 * Performance estimate for validate_project, from Wallpaper Engine's designer docs (performance/texture, performance/resolution):
 *   - texture memory: ~300 MB of VRAM or less is great, up to 500 MB acceptable
 *   - keep layers as small as needed; DXT5/DXT1 use a quarter of the memory of RGBA8888 (but are padded to powers of two)
 *   - use a resolution that exists on monitors
 */

/** the official resolutions listed in the docs ("Other Resolution" otherwise) */
const OFFICIAL = new Set(("1280x720 1366x768 1920x1080 2560x1440 3840x2160 2560x1080 3440x1440 3840x1080 5120x1440 7680x2160 4096x768 5760x1080 7680x1440 11520x2160 " +
  "720x1280 1080x1920 1440x2560 2160x3840").split(" "));

const MB = 1024 * 1024;
export const VRAM_GOOD_MB = 300, VRAM_MAX_MB = 500;
/** effect.json "performance" hints seen in assets/effects: "expensive" and "veryexpensive" */
const WEIGHT: Record<string, number> = { expensive: 2, veryexpensive: 4 };
/** ponytail: no GPU measurements behind this. 25 is the 90th percentile of the load of 168 installed Workshop scenes (median 4, 95th 41); recalibrate if lag shows up below it */
export const LOAD_WARN = 25;

const mb = (n: number) => (n / MB).toFixed(1);

function head(file: string): Buffer {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(48); fs.readSync(fd, b, 0, 48, 0); return b; } finally { fs.closeSync(fd); }
}

interface TexUse { format: number; flags: number; texW: number; texH: number; imgW: number; imgH: number; bytes: number; who: string[] }

export function perfReport(dir: string, scene: any, cv: { w: number; h: number }): { lines: string[]; warns: string[] } {
  const warns: string[] = [];
  if (!OFFICIAL.has(`${cv.w}x${cv.h}`)) warns.push(`canvas ${cv.w}x${cv.h} is not an official Wallpaper Engine resolution ("Other Resolution"; on a 16:9 monitor the sides are cut off or extra pixels are rendered). Prefer 1920x1080 or 3840x2160.`);

  const texes = new Map<string, TexUse>();
  const addTex = (file: string | undefined, who: string): TexUse | undefined => {
    if (!file) return undefined;
    let t = texes.get(file);
    if (!t) {
      try { const h = texHeader(head(file)); t = { ...h, bytes: texBytes(h.format, h.texW, h.texH), who: [] }; } catch { return undefined; }
      texes.set(file, t);
    }
    if (!t.who.includes(who)) t.who.push(who);
    return t;
  };

  const costs: [number, string][] = [];
  let scripts = 0, particleSystems = 0, particles = 0;
  const canvasArea = cv.w * cv.h;
  for (const o of scene.objects as Obj[]) {
    const tag = `[${o.id}] ${o.name ?? "?"}`, kind = kindOf(o), util = utilKind(o);
    const xf = worldXf(scene, o);
    const size = parseVec(o.size, [cv.w, cv.h]);
    const shown = [size[0] * Math.abs(xf.sx), size[1] * Math.abs(xf.sy)];
    if (kind === "image" && !util) {
      const t = addTex(layerTexFile(dir, o), tag);
      // docs: "always make sure image layers are as small as needed" - more than 2x per side is wasted even on a 4K screen
      if (t && !(t.flags & 4) /* sprite sheets hold many frames */ && shown[0] > 0 && shown[1] > 0 && t.imgW > 2 * shown[0] && t.imgH > 2 * shown[1] && t.imgW * t.imgH >= 512 * 512)
        warns.push(`${tag}: texture ${t.imgW}x${t.imgH} is shown at ${Math.round(shown[0])}x${Math.round(shown[1])} canvas px - scale it down (add_layer size) to save video memory.`);
    }
    if (kind === "particle") {
      particleSystems++;
      const j = readJson(path.join(dir, String(o.particle))) ?? readJson(path.join(ASSETS, String(o.particle)));
      particles += Number(j?.maxcount) || 0;
    }
    let passes = 0;
    for (const e of o.effects ?? []) {
      for (const p of e.passes ?? []) for (const name of p.textures ?? []) if (typeof name === "string") addTex(findTexFile(dir, name), `${tag} (effect texture)`);
      if (isHidden(e)) continue;
      const info = loadEffect(String(e.file ?? ""), dir);
      passes += (info?.passCount ?? (e.passes?.length || 1)) * (WEIGHT[info?.performance ?? ""] ?? 1);
    }
    // effect passes render at the layer's own size (not its on-screen scale): a 512 px layer blown up 10x is still a 512 px pass
    if (passes && !isHidden(o)) costs.push([passes * (size[0] * size[1]) / canvasArea, tag]);
  }
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const k in v) { if (k === "script" && typeof v[k] === "string") scripts++; else walk(v[k]); }
  };
  walk(scene.objects);

  // texture memory
  const all = [...texes.values()];
  const total = all.reduce((s, t) => s + t.bytes, 0);
  const lines = [`Performance estimate (heuristic; the editor's View > Show Stats > "Active texture memory" is the exact figure):`];
  lines.push(`  Texture memory ~${mb(total)} MB in ${all.length} textures (WE recommends ${VRAM_GOOD_MB} MB or less, ${VRAM_MAX_MB} MB at most; render targets, particle sprites and mipmaps not counted).`);
  const top = [...all].sort((a, b) => b.bytes - a.bytes).slice(0, 4).filter(t => t.bytes >= 0.5 * MB);
  if (top.length) lines.push(`  Largest: ${top.map(t => `${mb(t.bytes)} MB ${t.imgW}x${t.imgH} ${TEX_FORMAT_NAMES[t.format] ?? "fmt" + t.format} "${t.who[0].replace(/^\[\d+\] /, "")}"`).join("; ")}`);
  if (total / MB > VRAM_MAX_MB) warns.push(`texture memory ~${mb(total)} MB is above ${VRAM_MAX_MB} MB: it can make the desktop sluggish on cards with little VRAM. Shrink layers, crop transparent borders, or use DXT5.`);
  else if (total / MB > VRAM_GOOD_MB) warns.push(`texture memory ~${mb(total)} MB is above the recommended ${VRAM_GOOD_MB} MB.`);
  const pad16 = (n: number) => Math.ceil(n / 16) * 16;
  const save = all.filter(t => t.format === TEX_RGBA8888 && !(t.flags & (4 | 32))).reduce((s, t) => s + Math.max(0, t.bytes - texBytes(TEX_DXT5, pad16(t.texW), pad16(t.texH))), 0);
  if (save >= 10 * MB) lines.push(`  DXT on the RGBA8888 layers would save about ${mb(save)} MB: run optimize_textures (slightly lossy; the editor's layer > Advanced Texture Settings > Format does the same but pads to powers of two).`);
  for (const t of all) if (t.format !== TEX_RGBA8888 && t.texW * t.texH >= 1.5 * t.imgW * t.imgH && t.bytes >= MB)
    warns.push(`${t.who[0]}: ${TEX_FORMAT_NAMES[t.format]} texture padded from ${t.imgW}x${t.imgH} to ${t.texW}x${t.texH}, ${Math.round(100 - 100 * t.imgW * t.imgH / (t.texW * t.texH))}% of its memory is padding. A side that is just above a power of two (e.g. 1080 -> 1024) halves it.`);

  // GPU: every effect pass redraws its whole layer
  const load = costs.reduce((s, c) => s + c[0], 0);
  if (costs.length) {
    const tops = costs.sort((a, b) => b[0] - a[0]).slice(0, 3).map(c => `${c[1]} (${c[0].toFixed(1)})`).join("; ");
    lines.push(`  Effect load ~${load.toFixed(1)} full-canvas passes over ${costs.length} layers (expensive effects count x2, very expensive x4). Heaviest: ${tops}`);
    if (load > LOAD_WARN) warns.push(`effect load ~${load.toFixed(1)} full-canvas passes is high (above ${LOAD_WARN}): expect lag on weaker GPUs. Mask or shrink the layers with effects, or drop expensive effects.`);
  } else lines.push("  Effect load: no layer has effects.");
  lines.push(`  Scripts: ${scripts}; particle systems: ${particleSystems}${particleSystems ? ` (up to ${particles} particles)` : ""}.`);
  return { lines, warns };
}
