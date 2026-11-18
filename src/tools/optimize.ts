import * as fs from "fs";
import * as path from "path";
import { layerTexFile } from "../render";
import { Obj, findLayer, kindOf, openScene, utilKind } from "../sceneio";
import { TEX_FORMAT_NAMES, TEX_RGBA8888, encodeTex, parseTex, texBytes, texToRgba } from "../tex";

const MB = 1024 * 1024;

/**
 * Re-encode the plain RGBA8888 pictures of a project as DXT5 (with alpha) or DXT1 (fully opaque): a quarter of the video memory for a
 * slight loss. Only the albedo .tex of image layers; sprite sheets, videos and already compressed textures are left alone.
 * Back up first (backup_project): the .tex is replaced, the original .png next to it stays for a manual redo.
 */
export async function optimizeTextures(project: string, a: { layer?: string | number; format?: "auto" | "dxt5" | "dxt1"; min_size?: number }): Promise<string> {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  const layers: Obj[] = a.layer !== undefined ? [findLayer(scene, a.layer)] : scene.objects.filter((o: Obj) => kindOf(o) === "image" && !utilKind(o));
  const minPx = (a.min_size ?? 256) ** 2;
  const done = new Set<string>(), out: string[] = [];
  let saved = 0;
  for (const o of layers) {
    const f = layerTexFile(dir, o);
    if (!f || done.has(f) || !f.startsWith(dir)) continue;       // textures of WE's own assets are not ours to change
    done.add(f);
    const t = parseTex(fs.readFileSync(f));
    const name = path.basename(f, ".tex");
    if (t.format !== TEX_RGBA8888 || (t.flags & (4 | 32))) { if (a.layer !== undefined) out.push(`${name}: ${TEX_FORMAT_NAMES[t.format] ?? t.format}${t.flags & 4 ? " sprite sheet" : t.flags & 32 ? " video" : ""} stays as it is.`); continue; }
    if (t.imgW * t.imgH < minPx && a.layer === undefined) continue;
    const { rgba, w, h } = await texToRgba(fs.readFileSync(f));
    let opaque = true;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
    const fmt = a.format && a.format !== "auto" ? a.format : opaque ? "dxt1" : "dxt5";
    if (fmt === "dxt1" && !opaque) { out.push(`${name}: has transparency, dxt1 would lose it - use dxt5 or auto.`); continue; }
    const before = texBytes(t.format, t.texW, t.texH);
    const buf = await encodeTex(rgba, w, h, { format: fmt, tile: !(t.flags & 2), nointerp: !!(t.flags & 1) });
    fs.writeFileSync(f, buf);
    const tj = f + "-json";
    if (fs.existsSync(tj)) { try { const j = JSON.parse(fs.readFileSync(tj, "utf8")); j.format = fmt; fs.writeFileSync(tj, JSON.stringify(j, null, "\t")); } catch { /* leave it */ } }
    const hdr = parseTex(buf), after = texBytes(hdr.format, hdr.texW, hdr.texH);
    saved += before - after;
    out.push(`${name}: ${w}x${h} RGBA8888 ${(before / MB).toFixed(1)} MB -> ${fmt.toUpperCase()} ${(after / MB).toFixed(1)} MB (stored ${hdr.texW}x${hdr.texH}).`);
  }
  if (!out.length) return "Nothing to compress: no plain RGBA8888 image layer of at least " + Math.sqrt(minPx) + " px (pass layer to force one, min_size to lower the limit).";
  return [...out, `Saved ~${(saved / MB).toFixed(1)} MB of video memory. Check the look with capture_wallpaper; to undo, restore_project or re-add the layer from its .png.`].join("\n");
}
