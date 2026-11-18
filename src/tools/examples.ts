import * as fs from "fs";
import * as path from "path";
import { WORKSHOP_PATH, DEFAULT_PROJECTS_PATH, MY_PROJECTS_PATH } from "../config";
import { openPkg } from "../pkg";
import { Obj, openScene, saveScene, nextId, findLayer, worldXf, localFromWorld, setLocal, markAudio } from "../sceneio";
import { describeLayer, updateLayer } from "./scene";

/* ====================================================================
   Learn from the installed scenes (Workshop, default, mine): find one that uses an effect / a feature, read how a layer is built,
   and copy a layer (children, effects, masks, scripts, textures, particles...) into a project.
   ==================================================================== */

interface Src { dir: string; id: string; title: string; names(): string[]; has(n: string): boolean; read(n: string): Buffer; scene: any; pj: any }

const stripBom = (b: Buffer) => b.toString("utf8").replace(/^\uFEFF/, "");

const sceneDirs = (): string[] =>
  [WORKSHOP_PATH, DEFAULT_PROJECTS_PATH, MY_PROJECTS_PATH].filter((r): r is string => !!r && fs.existsSync(r))
    .flatMap(r => fs.readdirSync(r).map(n => path.join(r, n)).filter(d => fs.existsSync(path.join(d, "project.json"))));

function walkNames(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walkNames(dir, rel + e.name + "/") : [rel + e.name]));
}

/** A scene project folder: scene.pkg (Workshop) or loose files (default / own projects). undefined when it is not a scene. */
function openSrc(dir: string): Src | undefined {
  let pj: any;
  try { pj = JSON.parse(stripBom(fs.readFileSync(path.join(dir, "project.json")))); } catch { return undefined; }
  if (pj.type !== "scene") return undefined;
  const pkgFile = path.join(dir, "scene.pkg"), file = String(pj.file ?? "scene.json");
  const pkg = fs.existsSync(pkgFile) ? openPkg(pkgFile) : undefined;
  const src: Omit<Src, "scene"> = pkg
    ? { dir, id: path.basename(dir), title: pj.title ?? path.basename(dir), pj, names: () => [...pkg.entries.keys()], has: n => pkg.entries.has(n), read: n => pkg.read(n)! }
    : { dir, id: path.basename(dir), title: pj.title ?? path.basename(dir), pj, names: () => walkNames(dir), has: n => fs.existsSync(path.join(dir, n)), read: n => fs.readFileSync(path.join(dir, n)) };
  if (!src.has(file)) return undefined;
  try { return { ...src, scene: JSON.parse(stripBom(src.read(file))) }; } catch { return undefined; }
}

function resolveSrc(ref: string): Src {
  const dirs = sceneDirs(), q = ref.toLowerCase();
  const dir = (path.isAbsolute(ref) && fs.existsSync(ref) ? ref : undefined)
    ?? dirs.find(d => path.basename(d).toLowerCase() === q)
    ?? dirs.find(d => { try { return String(JSON.parse(stripBom(fs.readFileSync(path.join(d, "project.json")))).title ?? "").toLowerCase() === q; } catch { return false; } });
  const src = dir ? openSrc(dir) : undefined;
  if (!src) throw new Error(`No installed scene wallpaper "${ref}" (use the Workshop id, the folder name, the exact title or an absolute path; find_examples lists them).`);
  return src;
}

/* ---------------- find ---------------- */

interface Info { id: string; title: string; objects: number; effects: Map<string, number>; features: string[] }
const index = new Map<string, Info>();

function infoOf(dir: string): Info | undefined {
  const key = dir + ":" + fs.statSync(path.join(dir, "project.json")).mtimeMs;
  if (index.has(key)) return index.get(key);
  const src = openSrc(dir);
  if (!src) return undefined;
  const text = JSON.stringify(src.scene), objs: Obj[] = src.scene.objects ?? [], names = src.names();
  const effects = new Map<string, number>();
  for (const o of objs) for (const e of o.effects ?? []) { const n = String(e.file ?? "").replace(/^effects\//, "").replace(/\/effect\.json$/, ""); effects.set(n, (effects.get(n) ?? 0) + 1); }
  const f: [string, boolean][] = [
    ["audio", /registerAudioBuffers|"audioprocessing"/i.test(text)], ["media", /media(Properties|Thumbnail|Playback)Changed/.test(text)],
    ["cursor", /cursor(Down|Up|Click|Move|Enter|Leave)|cursorWorldPosition/.test(text)], ["scripts", /"script"\s*:/.test(text)],
    ["lights", objs.some(o => o.light)], ["particles", objs.some(o => o.particle)], ["text", objs.some(o => o.text !== undefined)],
    ["puppet", objs.some(o => o.puppet) || names.some(n => n.endsWith(".mdl"))], ["video", names.some(n => /\.(mp4|webm)$/i.test(n))], ["sounds", objs.some(o => o.sound)],
    ["animated", /"animation"\s*:/.test(text)],
  ];
  const info = { id: src.id, title: src.title, objects: objs.length, effects, features: f.filter(x => x[1]).map(x => x[0]) };
  index.set(key, info);
  return info;
}

export const EXAMPLE_FEATURES = ["audio", "media", "cursor", "scripts", "lights", "particles", "text", "puppet", "video", "sounds", "animated"];

export function findExamples(a: { query?: string; effect?: string; feature?: string; limit?: number }): string {
  const q = a.query?.toLowerCase(), eff = a.effect?.toLowerCase();
  const hits: { info: Info; uses: number }[] = [];
  for (const d of sceneDirs()) {
    let info: Info | undefined;
    try { info = infoOf(d); } catch { continue; }
    if (!info) continue;
    if (q && !(info.title.toLowerCase().includes(q) || info.id.toLowerCase() === q)) continue;
    if (a.feature && !info.features.includes(a.feature)) continue;
    const uses = eff ? [...info.effects].filter(([n]) => n.toLowerCase().includes(eff)).reduce((s, [, c]) => s + c, 0) : 0;
    if (eff && !uses) continue;
    hits.push({ info, uses });
  }
  hits.sort((x, y) => y.uses - x.uses || y.info.objects - x.info.objects);
  const top = hits.slice(0, a.limit ?? 20);
  if (!top.length) return "No installed scene matches.";
  return [
    `${hits.length} installed scene(s) match${hits.length > top.length ? ` (showing ${top.length})` : ""}. Inspect one with copy_example_layer {source:<id>}; effect parameters of a layer with {source, layer}.`,
    ...top.map(({ info, uses }) => `- ${info.id} "${info.title}": ${info.objects} layers${eff ? `, ${a.effect} x${uses}` : ""}; effects: ${[...info.effects].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(", ") || "none"}; ${info.features.join(", ") || "no scripts / particles"}`),
  ].join("\n");
}

/* ---------------- inspect / copy ---------------- */

/** a layer and everything below it */
function subtree(scene: any, root: Obj): Obj[] {
  const out: Obj[] = [root];
  for (let i = 0; i < out.length; i++) for (const o of scene.objects) if (o.parent === out[i].id && !out.includes(o)) out.push(o);
  return scene.objects.filter((o: Obj) => out.includes(o)); // back in scene order
}

const short = (v: any, n = 160) => { const s = JSON.stringify(v); return s.length > n ? s.slice(0, n) + "..." : s; };

function inspect(src: Src, root?: Obj): string {
  const { scene } = src, objs: Obj[] = root ? subtree(scene, root) : scene.objects;
  const props = Object.entries(src.pj.general?.properties ?? {}).map(([k, v]: [string, any]) => `${k}(${v.type})`);
  const g = scene.general ?? {};
  const lines = [
    `"${src.title}" (${src.id}): ${scene.objects.length} layers, canvas ${g.orthogonalprojection?.width}x${g.orthogonalprojection?.height}; scene settings: bloom ${g.bloom ? "on" : "off"}, parallax ${g.cameraparallax ? "on" : "off"}, camera shake ${g.camerashake ? "on" : "off"}, ambient ${g.ambientcolor ?? "?"}.`,
    props.length ? `User properties: ${props.join(", ")}` : "",
    ...objs.map(o => "  " + describeLayer(scene, o)),
  ];
  if (root) {
    for (const o of objs) {
      for (const [i, e] of (o.effects ?? []).entries()) {
        const vals = Object.assign({}, ...(e.passes ?? []).map((p: any) => p.constantshadervalues ?? {}), ...(e.passes ?? []).map((p: any) => (p.combos ? { combos: p.combos } : {})));
        lines.push(`  [${o.id}] effect #${i} ${String(e.file).replace(/^effects\//, "").replace(/\/effect\.json$/, "")}: ${short(vals, 400)}`);
      }
      for (const [k, v] of Object.entries(o)) if (v && typeof v === "object" && typeof (v as any).script === "string") lines.push(`  [${o.id}] script on ${k}: ${short((v as any).script.replace(/\s+/g, " ").replace(/^'use strict';\s*/, ""), 500)}`);
    }
  } else lines.push("Pass layer (id or name) to see one layer's effect parameters and scripts, and project to copy it.");
  return lines.filter(Boolean).join("\n");
}

const PATH_RE = /^(models|materials|particles|effects|shaders|scripts|sounds|fonts|masks)\/[^"\0]+\.[a-z0-9]+$/i;
const TEXT_REF = /(?:models|materials|particles|effects|shaders|scripts|sounds)\/[\w./ -]+?\.(?:json|mdl|tex|frag|vert|h|mp3|ogg|wav)/gi;

/** Every file a layer needs, following references through models, materials, effects, particles, shaders and puppets. */
function dependencies(src: Src, objs: Obj[]): Set<string> {
  const files = new Set<string>(), queue: string[] = [];
  const add = (n: string) => { if (!files.has(n) && src.has(n)) { files.add(n); queue.push(n); } };
  const walk = (v: any): void => {
    if (typeof v === "string") { if (PATH_RE.test(v)) add(v); return; }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (k === "textures" && Array.isArray(x)) for (const t of x) if (typeof t === "string") { add(`materials/${t}.tex`); add(`materials/${t}.tex-json`); add(`materials/${t}.png`); }
      if (k === "shader" && typeof x === "string") for (const e of ["frag", "vert", "geom"]) add(`shaders/${x}.${e}`);
      walk(x);
    }
  };
  objs.forEach(walk);
  while (queue.length) {
    const f = queue.shift()!;
    if (f.endsWith(".json")) { try { walk(JSON.parse(stripBom(src.read(f)))); } catch { /* not json */ } }
    else if (f.endsWith(".mdl")) for (const m of src.read(f).toString("latin1").match(TEXT_REF) ?? []) add(m);
    else if (/\.(frag|vert|geom|h)$/.test(f)) for (const m of src.read(f).toString("utf8").matchAll(/#include\s+"([^"]+)"/g)) add(`shaders/${m[1]}`);
  }
  return files;
}

/**
 * Copy a layer (and its children) into a project. Files keep their relative paths: if the project already has one with different content the copy is refused
 * (nothing written). ponytail: that is the ceiling - renaming on collision would mean rewriting every reference, .mdl puppets included.
 * User-property bindings are flattened to their current value (the source's property definitions are not copied); re-expose with bind / update_properties.
 */
function copyLayer(src: Src, root: Obj, project: string, o: { x?: number; y?: number; name?: string }): string {
  const ctx = openScene(project), { scene, dir } = ctx;
  const orig = subtree(src.scene, root), objs: Obj[] = structuredClone(orig);
  // ids: one id space for objects, effects and passes
  const ids = new Map<number, number>();
  let next = nextId(scene);
  const remap = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(remap);
    if (v && typeof v === "object") {
      if (typeof v.id === "number" && !ids.has(v.id)) ids.set(v.id, next++);
      Object.values(v).forEach(remap);
    }
  };
  remap(objs);
  let flattened = 0;
  const fix = (v: any): any => {
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") {
      if ("user" in v) { flattened++; return "value" in v ? fix(v.value) : undefined; }
      for (const k of Object.keys(v)) { const r = fix(v[k]); if (r === undefined) delete v[k]; else v[k] = r; }
      if (typeof v.id === "number") v.id = ids.get(v.id);
    }
    return v;
  };
  objs.forEach((x, i) => { const parent = x.parent; fix(x); if (parent !== undefined && ids.has(parent)) x.parent = ids.get(parent); else delete x.parent; if (i === 0) delete x.parent; });
  // the copy keeps its place in the world even if its parent stays behind
  if (root.parent !== undefined) setLocal(objs[0], localFromWorld(scene, undefined, worldXf(src.scene, root)));
  if (o.name) objs[0].name = o.name;

  const files = dependencies(src, orig);
  const conflicts = [...files].filter(f => fs.existsSync(path.join(dir, f)) && !fs.readFileSync(path.join(dir, f)).equals(src.read(f)));
  if (conflicts.length) throw new Error(`Not copied: the project already has different files at ${conflicts.slice(0, 6).join(", ")}${conflicts.length > 6 ? ` (+${conflicts.length - 6})` : ""}. Use a project without them.`);
  for (const f of files) {
    const dest = path.join(dir, f);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src.read(f));
  }
  scene.objects.push(...objs);
  saveScene(ctx);
  const audio = [...files].some(f => /\.(frag|vert)$/.test(f) && src.read(f).toString("utf8").includes("g_AudioSpectrum")); // audio-reactive shader: needs supportsaudioprocessing
  if (audio) markAudio(dir);
  if (o.x !== undefined || o.y !== undefined) updateLayer(project, objs[0].id, { x: o.x, y: o.y });
  const top = new Map<string, number>();
  for (const f of files) top.set(f.split("/")[0], (top.get(f.split("/")[0]) ?? 0) + 1);
  return [
    `Copied ${objs.length} layer(s) from "${src.title}" (${src.id}) into ${project}: ${objs.map(x => `[${x.id}] ${x.name}`).join(", ")}, plus ${files.size} file(s) (${[...top].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}).`,
    audio ? "The effect reacts to audio: supportsaudioprocessing was switched on in project.json." : "",
    flattened ? `${flattened} user-property binding(s) of the source were fixed to their current value.` : "",
    "Scene-level settings it may rely on (bloom, camera parallax, ambient) are NOT copied: see the settings line of the inspect output and scene_settings. Check it with capture_wallpaper.",
  ].filter(Boolean).join("\n");
}

export function copyExampleLayer(a: { source: string; layer?: string | number; project?: string; name?: string; x?: number; y?: number }): string {
  const src = resolveSrc(a.source);
  if (a.layer === undefined) return inspect(src);
  const root = findLayer(src.scene, a.layer);
  return a.project ? copyLayer(src, root, a.project, a) : inspect(src, root);
}
