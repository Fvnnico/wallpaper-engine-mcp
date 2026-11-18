import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { ASSETS, loadEffect } from "../effects";
import { WORKSHOP_PATH } from "../config";
import { unpackPkg } from "../pkg";
import { encodeTex, loadRgba, texToRgba } from "../tex";
import { gridOverlay, layerTexFile, layerTexture, niceStep, Region, renderScene } from "../render";
import { Obj, findLayer, kindOf, openScene, parseVec, sceneSize, usesAudio, utilKind, worldXf } from "../sceneio";
import { resolveProject } from "../resolve";
import { describeLayer } from "./scene";
import { materialOf } from "./light";
import { perfReport } from "./perf";
import { PARTICLE_COMPONENTS } from "./newparticles";

export interface ToolImage { data: Buffer; mime: string }
export interface ToolOutput { text: string; images?: ToolImage[] }

/* ====================================================================
   preview_scene
   ==================================================================== */

export interface PreviewArgs {
  project: string;
  /** zoom into a canvas region (px, top-left origin) */
  region?: Region;
  width?: number;
  /** grid step in canvas px; true/auto when omitted and `grid` is requested */
  grid?: number | boolean;
  labels?: boolean;
  /** only these layers */
  only?: (string | number)[];
  /** overlay the effect masks of these layers (red) */
  masks_of?: (string | number)[];
  save_thumbnail?: boolean;
}

export async function previewScene(a: PreviewArgs): Promise<ToolOutput> {
  const ctx = openScene(a.project);
  const cv = sceneSize(ctx.scene);
  const region = a.region ?? { x: 0, y: 0, w: cv.w, h: cv.h };
  if (!(region.w > 0 && region.h > 0)) throw new Error("region needs positive w and h.");
  const ids = (refs?: (string | number)[]) => refs?.map(r => findLayer(ctx.scene, r).id);
  const grid = a.grid === true ? niceStep(Math.max(region.w, region.h)) : typeof a.grid === "number" ? a.grid : 0;
  const r = await renderScene(ctx, {
    region, width: a.width ?? (a.region ? 1024 : 1280), grid, labels: a.labels ?? true,
    only: ids(a.only), masksOf: ids(a.masks_of),
  });
  const jpg = await sharp(r.png).jpeg({ quality: 85 }).toBuffer();
  if (a.save_thumbnail) {
    const full = await renderScene(ctx, { width: 640, labels: false });
    const th = await sharp(full.png).resize(640, 360, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
    fs.writeFileSync(path.join(ctx.dir, "preview.jpg"), th);
  }
  const lines = [
    `Preview of "${path.basename(ctx.dir)}": canvas ${cv.w}x${cv.h}px, showing x ${region.x}..${region.x + region.w}, y ${region.y}..${region.y + region.h} at ${r.w}x${r.h} (${r.k.toFixed(3)} px per canvas px).`,
    grid ? `Grid every ${grid} canvas px (cyan = x, yellow = y; labels are canvas px, origin top-left).` : "",
    "Drawn: image + text layers with position, scale, rotation, alpha, tint, blend. Also simulated: the `opacity` effect (alpha x mask). NOT simulated: other effects, post-process layers, particles, animations, scripts (layers with effects are marked 'fx').",
    ...r.notes,
    "Layers (bottom -> top):",
    ...ctx.scene.objects.filter((o: Obj) => kindOf(o) !== "sound").map((o: Obj) => "  " + describeLayer(ctx.scene, o)),
    a.save_thumbnail ? "Saved preview.jpg as the wallpaper thumbnail." : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), images: [{ data: jpg, mime: "image/jpeg" }] };
}

/* ====================================================================
   inspect_image
   ==================================================================== */

const CHECKER = `<svg xmlns="http://www.w3.org/2000/svg" width="WW" height="HH"><defs><pattern id="c" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#8a8a8a"/><rect width="12" height="12" fill="#6c6c6c"/><rect x="12" y="12" width="12" height="12" fill="#6c6c6c"/></pattern></defs><rect width="100%" height="100%" fill="url(#c)"/></svg>`;

export interface InspectArgs {
  /** absolute image path (png/jpg/webp/.tex) */
  path?: string;
  /** or a layer of a project: its texture is inspected */
  project?: string; layer?: string | number;
  /** crop/zoom region in SOURCE px (top-left origin) */
  region?: Region;
  width?: number;
  grid?: number;
}

export async function inspectImage(a: InspectArgs): Promise<ToolOutput> {
  let rgba: Buffer, w: number, h: number, label: string;
  if (a.project && a.layer !== undefined) {
    const ctx = openScene(a.project);
    const obj = findLayer(ctx.scene, a.layer);
    const t = await layerTexture(ctx.dir, obj);
    if (!t) throw new Error(`Layer "${obj.name}" has no readable still texture.`);
    ({ rgba, w, h } = t); label = `texture of layer [${obj.id}] "${obj.name}"`;
  } else if (a.path) {
    if (!path.isAbsolute(a.path) || !fs.existsSync(a.path)) throw new Error(`File not found: "${a.path}" (use an absolute path).`);
    if (a.path.toLowerCase().endsWith(".tex")) ({ rgba, w, h } = await texToRgba(fs.readFileSync(a.path)));
    else ({ rgba, w, h } = await loadRgba(a.path));
    label = a.path;
  } else throw new Error("Give either path or project + layer.");

  // opaque bounding box + centroid of the visible pixels
  let minX = w, minY = h, maxX = -1, maxY = -1, sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; sx += x; sy += y; n++; }
  }
  const region = a.region ?? { x: 0, y: 0, w, h };
  const rx = Math.max(0, Math.floor(region.x)), ry = Math.max(0, Math.floor(region.y));
  const rw = Math.max(1, Math.min(w - rx, Math.floor(region.w))), rh = Math.max(1, Math.min(h - ry, Math.floor(region.h)));
  const outW = Math.max(64, Math.min(2048, a.width ?? 1024));
  const k = outW / rw, outH = Math.max(1, Math.round(rh * k));
  const crop = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).extract({ left: rx, top: ry, width: rw, height: rh }).resize(outW, outH, { fit: "fill", kernel: k > 1 ? "nearest" : "lanczos3" }).png().toBuffer();
  const step = a.grid ?? niceStep(Math.max(rw, rh));
  const bg = await sharp(Buffer.from(CHECKER.replace("WW", String(outW)).replace("HH", String(outH)))).png().toBuffer();
  const out = await sharp(bg).composite([{ input: crop }, { input: gridOverlay(outW, outH, { x: rx, y: ry, w: rw, h: rh }, k, step) }]).jpeg({ quality: 85 }).toBuffer();
  const text = [
    `${label}: ${w}x${h} px. Showing x ${rx}..${rx + rw}, y ${ry}..${ry + rh} (grid ${step} px; labels are SOURCE px, origin top-left; transparent = checkerboard).`,
    n ? `Visible (alpha>16) bounding box: x ${minX}..${maxX}, y ${minY}..${maxY} (${maxX - minX + 1}x${maxY - minY + 1}); centroid (${Math.round(sx / n)}, ${Math.round(sy / n)}); ${(100 * n / (w * h)).toFixed(1)}% of the image is visible.` : "The image is fully transparent.",
    "Mask shapes with space:'layer' use these source px; with the default space:'canvas' use canvas px from preview_scene.",
  ].join("\n");
  return { text, images: [{ data: out, mime: "image/jpeg" }] };
}

/* ====================================================================
   convert_texture, unpack_pkg
   ==================================================================== */

export async function convertTexture(a: { input: string; output?: string; mask?: boolean }): Promise<string> {
  if (!path.isAbsolute(a.input) || !fs.existsSync(a.input)) throw new Error(`Input not found: "${a.input}" (absolute path).`);
  const isTex = a.input.toLowerCase().endsWith(".tex");
  const out = a.output ?? a.input.replace(/\.[^.]+$/, isTex ? ".png" : ".tex");
  if (isTex) {
    const { rgba, w, h } = await texToRgba(fs.readFileSync(a.input));
    await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(out);
    return `Decoded ${a.input} -> ${out} (${w}x${h}).`;
  }
  const { rgba, w, h } = await loadRgba(a.input);
  fs.writeFileSync(out, await encodeTex(rgba, w, h, a.mask ? { format: "r8" } : {}));
  return `Encoded ${a.input} -> ${out} (${w}x${h}, ${a.mask ? "R8 mask" : "RGBA8888 + mips"}). Note: add_layer/create_scene_wallpaper do this automatically.`;
}

export async function unpackPackage(a: { source: string; output?: string; filter?: string; decode_textures?: boolean }): Promise<string> {
  let pkg = a.source;
  if (/^\d+$/.test(a.source) && WORKSHOP_PATH) pkg = path.join(WORKSHOP_PATH, a.source, "scene.pkg");
  else if (!path.isAbsolute(a.source)) { const d = resolveProject(a.source); if (d) pkg = path.join(d, "scene.pkg"); }
  else if (fs.existsSync(a.source) && fs.statSync(a.source).isDirectory()) pkg = path.join(a.source, "scene.pkg");
  if (!fs.existsSync(pkg)) throw new Error(`No .pkg found for "${a.source}" (looked at ${pkg}).`);
  const out = a.output ?? path.join(os.tmpdir(), "we_unpacked", path.basename(path.dirname(pkg)) + "_" + path.basename(pkg, ".pkg"));
  const only = a.filter ? new RegExp(a.filter, "i") : undefined;
  const r = unpackPkg(pkg, out, only);
  let decoded = 0;
  if (a.decode_textures) {
    for (const e of r.written.filter(w => w.name.toLowerCase().endsWith(".tex"))) {
      try { const f = path.join(out, e.name); const t = await texToRgba(fs.readFileSync(f)); await sharp(t.rgba, { raw: { width: t.w, height: t.h, channels: 4 } }).png().toFile(f.replace(/\.tex$/i, ".png")); decoded++; } catch { /* unsupported texture */ }
    }
  }
  const top = new Map<string, number>();
  for (const e of r.written) { const k = e.name.includes("/") ? e.name.split("/")[0] + "/" : e.name; top.set(k, (top.get(k) ?? 0) + 1); }
  return [
    `Unpacked ${r.written.length}/${r.total} files (${r.version}) from ${pkg} to ${out}`,
    `Top level: ${[...top].map(([k, v]) => (k.endsWith("/") ? `${k} (${v})` : k)).join(", ")}`,
    decoded ? `Decoded ${decoded} textures to .png next to the .tex files.` : "",
    "Read files with read_wallpaper_file only inside projects; for the unpacked folder use your normal file tools.",
  ].filter(Boolean).join("\n");
}

/* ====================================================================
   validate_project
   ==================================================================== */

const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "")); } catch { return undefined; } };

/** A particle file (and its child systems): readable, its material exists, children exist, component names are WE's (a typo silently does nothing). */
function particleIssues(dir: string, rel: string, tag: string, errors: string[], warns: string[], seen = new Set<string>()) {
  if (seen.has(rel)) return;
  seen.add(rel);
  let j: any;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, rel), "utf-8").replace(/^\uFEFF/, "").replace(/,\s*([}\]])/g, "$1")); } catch { errors.push(`${tag}: ${rel} is not valid JSON.`); return; }
  const m = String(j.material ?? "");
  if (!m || (!fs.existsSync(path.join(dir, m)) && !fs.existsSync(path.join(ASSETS, m)))) errors.push(`${tag}: ${rel} material "${m}" not found.`);
  for (const cat of ["emitter", "initializer", "operator", "renderer"] as const)
    for (const c of j[cat] ?? []) if (!(PARTICLE_COMPONENTS[cat] as readonly string[]).includes(c?.name)) warns.push(`${tag}: ${rel} ${cat} "${c?.name}" is not a known component (it probably does nothing).`);
  for (const c of j.children ?? []) {
    if (!c?.name || !fs.existsSync(path.join(dir, String(c.name)))) errors.push(`${tag}: ${rel} child system "${c?.name}" not found.`);
    else particleIssues(dir, String(c.name), tag, errors, warns, seen);
  }
}

export function validateProject(project: string): string {
  const dir = resolveProject(project);
  if (!dir) return `Project "${project}" not found.`;
  const errors: string[] = [], warns: string[] = [];
  const pj = readJson(path.join(dir, "project.json"));
  if (!pj) return `ERROR: project.json missing or invalid JSON in ${dir}`;
  if (pj.type !== "scene") return `project.json type is "${pj.type}" - validate_project checks scene wallpapers only (entry: ${pj.file}). ${pj.file && !fs.existsSync(path.join(dir, pj.file)) ? "ERROR: entry file missing." : "Entry file exists."}`;
  if (!pj.preview || !fs.existsSync(path.join(dir, pj.preview))) warns.push("No preview image (project.json preview). Run preview_scene with save_thumbnail.");
  const props = pj.general?.properties ?? {};
  let sceneObj: any;
  try { sceneObj = openScene(dir); } catch (e: any) { return `ERROR: ${e.message}`; }
  const { scene } = sceneObj;
  const has = (rel: string) => fs.existsSync(path.join(dir, rel)) || fs.existsSync(path.join(ASSETS, rel));
  const cv = sceneSize(scene);
  if (!scene.general?.orthogonalprojection) errors.push("general.orthogonalprojection missing (canvas size).");
  const seen = new Map<number, string>();
  const userRefs = (v: any, where: string) => {
    if (Array.isArray(v)) return v.forEach(x => userRefs(x, where));
    if (v && typeof v === "object") {
      if ("user" in v) { const name = typeof v.user === "string" ? v.user : v.user?.name; if (name && !props[name]) errors.push(`${where}: user property "${name}" is not defined in project.json.`); }
      for (const k in v) userRefs(v[k], where);
    }
  };
  for (const o of scene.objects as Obj[]) {
    const tag = `[${o.id}] ${o.name ?? "?"}`;
    if (typeof o.id !== "number") errors.push(`${tag}: missing numeric id.`);
    else if (seen.has(o.id)) errors.push(`${tag}: duplicate id ${o.id} (also ${seen.get(o.id)}).`); else seen.set(o.id, tag);
    if (o.parent !== undefined && !scene.objects.some((p: Obj) => p.id === o.parent)) errors.push(`${tag}: parent ${o.parent} does not exist.`);
    userRefs(o, tag);
    const kind = kindOf(o);
    if (kind === "image") {
      const model = typeof o.image === "string" ? o.image : "";
      if (!model || !has(model)) errors.push(`${tag}: model "${model}" not found.`);
      else if (utilKind(o)) {
        if (utilKind(o) !== "solid" && !o.effects?.length) warns.push(`${tag}: post-process layer without effects does nothing (add_effect).`);
      } else {
        const tex = layerTexFile(dir, o);
        if (!tex) warns.push(`${tag}: no .tex found behind ${model} (video/animated or missing texture).`);
        else {
          try {
            const b = fs.readFileSync(tex);
            if (b.subarray(0, 8).toString("ascii") !== "TEXV0005") warns.push(`${tag}: texture has unexpected header.`);
          } catch { errors.push(`${tag}: texture unreadable.`); }
        }
      }
      const mp = utilKind(o) ? undefined : materialOf(dir, o)?.pass;
      if (mp) {
        if (Number(mp.combos?.REFLECTION) && !Number(mp.combos?.NORMALMAP)) errors.push(`${tag}: reflection needs a normal map (set_material normal_map).`);
        for (const u of mp.usertextures ?? []) if (typeof u === "string" && props[u]?.type !== "scenetexture") errors.push(`${tag}: texture property "${u}" is not a "texture" property of project.json.`);
        for (const t of (mp.textures ?? []).slice(1)) if (typeof t === "string" && !has(`materials/${t}.tex`)) errors.push(`${tag}: material texture "${t}" missing (materials/${t}.tex).`);
      }
      const size = parseVec(o.size, [0, 0]);
      if (size[0] > 8192 || size[1] > 8192) warns.push(`${tag}: texture ${size.join("x")} is larger than 8192 px - may fail on some GPUs.`);
      const w = worldXf(scene, o);
      if (Math.abs(w.x) > cv.w * 3 || Math.abs(w.y) > cv.h * 3) warns.push(`${tag}: centre is far outside the canvas (${w.x.toFixed(0)}, ${(cv.h - w.y).toFixed(0)}).`);
    }
    if (kind === "particle") { if (!has(String(o.particle))) errors.push(`${tag}: particle file "${o.particle}" not found.`); else particleIssues(dir, String(o.particle), tag, errors, warns); }
    if (kind === "sound") for (const s of o.sound ?? []) if (!fs.existsSync(path.join(dir, s))) errors.push(`${tag}: sound "${s}" not found.`);
    for (const e of o.effects ?? []) {
      const ref = String(e.file ?? "");
      if (!has(ref)) { errors.push(`${tag}: effect file "${ref}" not found.`); continue; }
      const info = loadEffect(ref, dir) ?? undefined;
      if (info && info.passCount !== (e.passes ?? []).length) errors.push(`${tag}: effect ${ref} has ${(e.passes ?? []).length} pass entries, the effect defines ${info.passCount}.`);
      for (const p of e.passes ?? []) for (const t of p.textures ?? []) {
        if (typeof t === "string" && t.startsWith("masks/") && !fs.existsSync(path.join(dir, "materials", t + ".tex"))) errors.push(`${tag}: mask "${t}" missing (materials/${t}.tex).`);
      }
      if (info) for (const dep of readJson(path.join(dir, ref))?.dependencies ?? []) {
        if (typeof dep === "string" && !has(dep) && !fs.existsSync(path.join(ASSETS, "effects", info.ref, dep))) warns.push(`${tag}: effect dependency "${dep}" not found.`);
      }
      // the "shader" of each material must match the shader file names (a typo = the effect silently does nothing)
      if (info && !info.builtin) for (const p of readJson(path.join(dir, ref))?.passes ?? []) {
        const sh = readJson(path.join(dir, String(p.material ?? "")))?.passes?.[0]?.shader;
        if (typeof sh === "string") for (const ext of [".frag", ".vert"]) if (!has(`shaders/${sh}${ext}`) && !fs.existsSync(path.join(ASSETS, "shaders", sh + ext))) errors.push(`${tag}: shaders/${sh}${ext} missing (effect ${ref}: the "shader" of its material must match the file names).`);
      }
    }
  }
  if (usesAudio(JSON.stringify(scene)) && !pj.general?.supportsaudioprocessing) errors.push('The scene reacts to audio but project.json general.supportsaudioprocessing is not true: it would get no sound data (update_properties set_general {"supportsaudioprocessing": true}).');
  const nl = scene.objects.filter((o: Obj) => typeof o.light === "string").length;
  if (nl > 4) warns.push(`${nl} lights: each one costs GPU time on every lit layer; Wallpaper Engine's guide advises at most 4 (merge or switch some off).`);
  const leds = scene.objects.filter((o: Obj) => o.ledsource === true);
  if (leds.length > 1) warns.push(`${leds.length} layers are RGB sources (ledsource): only the topmost counts, the others are ignored. Keep one.`);
  for (const o of leds) { const s = parseVec(o.size, [0, 0]); if (s[0] * s[1] > 512 * 512) warns.push(`RGB source "${o.name}" is ${s[0]}x${s[1]}: a small layer (e.g. a 32x32 solid) is enough for the LEDs and saves video memory. It must stay inside the visible area.`); }
  const tl = scene.objects.length;
  const perf = perfReport(dir, scene, cv);
  warns.push(...perf.warns);
  const lines = [`Validated "${path.basename(dir)}" (${tl} objects, canvas ${cv.w}x${cv.h}).`];
  lines.push(errors.length ? `${errors.length} ERROR(S):` : "No errors.", ...errors.map(e => "  ERROR " + e));
  if (warns.length) lines.push(`${warns.length} warning(s):`, ...warns.map(w => "  warn  " + w));
  lines.push(...perf.lines);
  if (!errors.length) lines.push("Looks consistent. The final check is still apply_wallpaper + a look at the desktop.");
  return lines.join("\n");
}