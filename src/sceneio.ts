import * as fs from "fs";
import * as path from "path";
import { resolveProject } from "./resolve";

/* Scene coordinate system (verified on editor-made wallpapers):
 *   - canvas = general.orthogonalprojection {width,height}; (0,0) is the BOTTOM-left, y grows UP
 *   - object.origin is the CENTRE of a layer, object.size its natural pixel size, scale multiplies it
 *   - scene.json "angles" are RADIANS (verified in WE: 25 renders as 25 rad); z is the in-plane rotation, counter-clockwise +.
 *     Everything in this codebase (Xf.rot, tool arguments) is in DEGREES; only the stored z component is converted (RAD).
 *   - children (parent=id) use origin/scale/angles relative to the parent
 *   - objects[] is drawn first-to-last: the LAST object is on top
 */

export type Obj = Record<string, any>;
export interface SceneCtx { dir: string; file: string; scene: any }

export function openScene(project: string): SceneCtx {
  const dir = resolveProject(project);
  if (!dir) throw new Error(`Project "${project}" not found.`);
  let file = path.join(dir, "scene.json");
  const pj = path.join(dir, "project.json");
  if (fs.existsSync(pj)) {
    try { const p = JSON.parse(fs.readFileSync(pj, "utf-8")); if (p.file && /\.json$/i.test(p.file)) file = path.join(dir, p.file); } catch { /* keep default */ }
  }
  if (!fs.existsSync(file)) throw new Error(`No scene.json in "${project}". Is it a scene wallpaper?`);
  const scene = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(scene.objects)) scene.objects = [];
  return { dir, file, scene };
}

export function saveScene(ctx: SceneCtx): void {
  // general.lightconfig = how many lights of each type the scene has (the engine sizes its lighting from it): keep it true whatever changed
  const n: Record<string, number> = {};
  for (const o of ctx.scene.objects) if (typeof o.light === "string") { const k = o.light.replace(/^l/, ""); n[k] = (n[k] ?? 0) + 1; }
  if (Object.keys(n).length) ctx.scene.general = { ...ctx.scene.general, lightconfig: n }; else if (ctx.scene.general) delete ctx.scene.general.lightconfig;
  const text = JSON.stringify(ctx.scene, null, "\t");
  fs.writeFileSync(ctx.file, text);
  if (usesAudio(text)) markAudio(ctx.dir);
}

/** Audio scripts (registerAudioBuffers) and audio-reactive effect combos only get sound when project.json general.supportsaudioprocessing is true. */
export const usesAudio = (sceneText: string): boolean => /registerAudioBuffers|"audioprocessing":\s*(1|true)/i.test(sceneText);

export function markAudio(dir: string): void {
  const f = path.join(dir, "project.json");
  try {
    const pj = JSON.parse(fs.readFileSync(f, "utf-8").replace(/^\uFEFF/, ""));
    if (pj.general?.supportsaudioprocessing) return;
    pj.general = { ...pj.general, supportsaudioprocessing: true };
    fs.writeFileSync(f, JSON.stringify(pj, null, "\t"));
  } catch { /* no readable project.json: nothing to mark */ }
}

/** Largest numeric "id" anywhere in the scene + 1 (objects, effects, passes, animation layers share one id space). */
export function nextId(scene: any): number {
  let max = 0;
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.id === "number" && v.id > max) max = v.id;
      for (const k in v) walk(v[k]);
    }
  };
  walk(scene);
  return max + 1;
}

export function sceneSize(scene: any): { w: number; h: number } {
  const o = scene?.general?.orthogonalprojection;
  return { w: Number(o?.width) || 1920, h: Number(o?.height) || 1080 };
}

export function kindOf(o: Obj): "image" | "particle" | "sound" | "text" | "light" | "model" | "shape" | "group" {
  if (o.image !== undefined) return "image";
  if (o.particle !== undefined) return "particle";
  if (o.sound !== undefined) return "sound";
  if (o.text !== undefined) return "text";
  if (o.light !== undefined) return "light";
  if (o.model !== undefined) return "model";
  if (o.shape !== undefined) return "shape";
  return "group";
}

/** Editor utility layers (assets/models/util): flat colour, full-canvas post-process, rectangular post-process. They have no texture. */
export const UTIL_MODELS = { solid: "models/util/solidlayer.json", fullscreen: "models/util/fullscreenlayer.json", compose: "models/util/composelayer.json" } as const;
export type UtilKind = keyof typeof UTIL_MODELS;
export const utilKind = (o: Obj): UtilKind | undefined => (Object.keys(UTIL_MODELS) as UtilKind[]).find(k => UTIL_MODELS[k] === o.image);

/** Resolve a layer by numeric id or by name (case-insensitive, exact first, then unique substring). */
export function findLayer(scene: any, ref: string | number): Obj {
  const objs: Obj[] = scene.objects;
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    const hit = objs.find(o => o.id === Number(ref));
    if (hit) return hit;
  }
  const s = String(ref).toLowerCase();
  const exact = objs.filter(o => String(o.name ?? "").toLowerCase() === s);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Layer name "${ref}" is ambiguous (ids ${exact.map(o => o.id).join(", ")}). Use the numeric id.`);
  const part = objs.filter(o => String(o.name ?? "").toLowerCase().includes(s));
  if (part.length === 1) return part[0];
  throw new Error(part.length ? `Layer "${ref}" matches several layers (${part.map(o => `${o.id}:${o.name}`).join(", ")}). Use the id.` : `Layer "${ref}" not found. Use get_scene to list layers.`);
}

/* ---------------- value helpers ---------------- */

/** "x y z" -> numbers. Accepts {user,value} wrappers and arrays. */
export function parseVec(v: any, def: number[]): number[] {
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in v) v = v.value;
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "string") { const a = v.trim().split(/\s+/).map(Number); if (a.every(Number.isFinite)) return a; }
  if (typeof v === "number") return [v];
  return def;
}
export const vecStr = (a: number[]) => a.map(n => (+n).toFixed(5)).join(" ");

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "layer";
}

/** Parse "#rrggbb", "r g b" (0-1) or [r,g,b] into the "r g b" 0-1 string WE uses. */
export function colorStr(c: string | number[]): string {
  if (Array.isArray(c)) return vecStr(c.slice(0, 3));
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (m) { const n = parseInt(m[1], 16); return vecStr([(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]); }
  const a = c.trim().split(/\s+/).map(Number);
  if (a.length >= 3 && a.every(Number.isFinite)) return vecStr(a.slice(0, 3).map(x => (x > 1 ? x / 255 : x)));
  throw new Error(`Invalid colour "${c}". Use "#rrggbb" or "r g b" (0-1).`);
}

/* ---------------- user properties / bindings ---------------- */

export interface PropSpec {
  /** property key (what applyProperties / the editor uses) */
  property: string;
  /** label shown in the properties panel */
  label?: string;
  type?: "bool" | "slider" | "color" | "combo" | "textinput" | "group" | "text" | "texture" | "usershortcut";
  /** show this control only while the bool property with this key is on (greys out sliders of a disabled option) */
  show_if?: string;
  min?: number; max?: number; step?: number;
  options?: { label: string; value: string | number }[];
  /** default value (also the value used in the scene) */
  value?: any;
  /** combo properties only, for `visible`: show the layer/effect only while the combo equals this option value (several layers can share one combo) */
  condition?: string | number;
}
export const isPropSpec = (v: any): v is PropSpec => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.property === "string";

function projectJsonPath(dir: string) { return path.join(dir, "project.json"); }

/** Create (or keep) a user property in project.json and return the scene.json binding { user, value }. */
export function bindProperty(dir: string, spec: PropSpec, fallback: any): { user: string | { name: string; condition: string }; value: any } {
  const value = spec.value ?? fallback;
  const pj = JSON.parse(fs.readFileSync(projectJsonPath(dir), "utf-8").replace(/^\uFEFF/, ""));
  pj.general = pj.general ?? {};
  const props = (pj.general.properties = pj.general.properties ?? {});
  if (!props[spec.property]) {
    const type = spec.type === "texture" ? "scenetexture" : spec.type ?? (typeof value === "boolean" ? "bool" : typeof value === "number" ? "slider" : spec.options ? "combo" : /^[\d.\-\s]+$/.test(String(value)) && String(value).trim().split(/\s+/).length === 3 ? "color" : "textinput");
    const n = Object.keys(props).filter(k => k !== "schemecolor").length;
    const def: Record<string, any> = { index: n, order: 100 + n, text: spec.label ?? spec.property, type, value };
    if (type === "group" || type === "scenetexture" || type === "usershortcut") def.value = "";  // header / file picked by the viewer: nothing chosen yet
    if (type === "text") delete def.value;           // plain label (html allowed)
    if (spec.show_if) def.condition = `${spec.show_if}.value == true`;
    if (type === "slider") {
      def.min = spec.min ?? 0; def.max = spec.max ?? Math.max(1, Math.ceil(Math.abs(Number(value)) * 2));
      def.step = spec.step ?? (def.max - def.min > 20 ? 1 : 0.01); def.fraction = def.step < 1;
    }
    if (type === "combo") def.options = spec.options ?? [];
    if (type === "color") def.value = colorStr(value);
    props[spec.property] = def;
    fs.writeFileSync(projectJsonPath(dir), JSON.stringify(pj, null, "\t"));
  }
  // WE form used by hand-made scenes: {"user":{"name":..,"condition":"2"},"value":true} = visible while the combo equals "2"
  if (spec.condition !== undefined) return { user: { name: spec.property, condition: String(spec.condition) }, value: true };
  return { user: spec.property, value: props[spec.property].value ?? value };
}

/** Pass-through helper: plain values stay as they are, { property: ... } objects become bindings. */
export function bindable(dir: string, v: any, fallback: any): any {
  return isPropSpec(v) ? bindProperty(dir, v, fallback) : v;
}

/* ---------------- transforms ---------------- */

export interface Xf { x: number; y: number; sx: number; sy: number; rot: number }

/** WE draws text with an em of pointsize * 300/72 canvas px, whatever the canvas resolution (measured in WE 2.8: 40pt -> 167px em). */
export const PT_PX = 300 / 72;

/** degrees -> the radians scene.json stores in "angles" */
export const RAD = Math.PI / 180;
/** "angles" string for an in-plane rotation of `deg` degrees */
export const anglesStr = (deg: number): string => vecStr([0, 0, deg * RAD]);

/** World transform (2D) of an object, applying parents. Rotation in degrees (z). */
export function worldXf(scene: any, o: Obj, depth = 0): Xf {
  const org = parseVec(o.origin, [0, 0, 0]);
  const sc = parseVec(o.scale, [1, 1, 1]);
  const an = parseVec(o.angles, [0, 0, 0]);
  const own: Xf = { x: org[0] ?? 0, y: org[1] ?? 0, sx: sc[0] ?? 1, sy: sc[1] ?? sc[0] ?? 1, rot: (an[2] ?? 0) / RAD };
  const parent = o.parent !== undefined && depth < 16 ? scene.objects.find((p: Obj) => p.id === o.parent) : undefined;
  if (!parent) return own;
  const P = worldXf(scene, parent, depth + 1);
  const r = P.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const lx = own.x * P.sx, ly = own.y * P.sy;
  return { x: P.x + c * lx - s * ly, y: P.y + s * lx + c * ly, sx: own.sx * P.sx, sy: own.sy * P.sy, rot: own.rot + P.rot };
}

/** Anchor names -> offset from the layer centre in units of the layer size (y up). */
export const ANCHORS: Record<string, [number, number]> = {
  center: [0, 0], top: [0, 0.5], bottom: [0, -0.5], left: [-0.5, 0], right: [0.5, 0],
  "top-left": [-0.5, 0.5], "top-right": [0.5, 0.5], "bottom-left": [-0.5, -0.5], "bottom-right": [0.5, -0.5],
};

/** Layer centre (scene units, y up) so that `anchor` of the layer lands on the world point (wx, wy). */
export function originForAnchor(wx: number, wy: number, w: number, h: number, sx: number, sy: number, rotDeg: number, anchor: string): [number, number] {
  const a = ANCHORS[anchor];
  if (!a) throw new Error(`Unknown anchor "${anchor}". Use: ${Object.keys(ANCHORS).join(", ")}`);
  const dx = a[0] * w * sx, dy = a[1] * h * sy;
  const r = rotDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [wx - (c * dx - s * dy), wy - (s * dx + c * dy)];
}

/** Convert canvas pixels (origin top-left, y down) to scene units (origin bottom-left, y up). */
export const pxToScene = (x: number, y: number, canvasH: number): [number, number] => [x, canvasH - y];
export const sceneToPx = (x: number, y: number, canvasH: number): [number, number] => [x, canvasH - y];

/** Blend modes used by `colorBlendMode` (from assets/shaders/common_blending.h). */
export const BLEND_MODES: Record<string, number> = {
  normal: 0, darken: 1, multiply: 2, "color-burn": 3, subtract: 4, "darker-color": 5, lighten: 6, screen: 7,
  "color-dodge": 8, add: 9, "lighter-color": 10, overlay: 11, "soft-light": 12, "hard-light": 13, "vivid-light": 14,
  "linear-light": 15, "pin-light": 16, "hard-mix": 17, difference: 18, exclusion: 19, reflect: 21, glow: 22,
  phoenix: 23, average: 24, negation: 25, hue: 26, saturation: 27, color: 28, luminosity: 29, tint: 30,
  "add-alt": 31, "multiply-add": 32,
};
export function blendMode(v: string | number): number {
  if (typeof v === "number") return v;
  const n = BLEND_MODES[v.toLowerCase().replace(/[ _]/g, "-")];
  if (n === undefined) throw new Error(`Unknown blend mode "${v}". Use: ${Object.keys(BLEND_MODES).join(", ")}`);
  return n;
}

/** Local transform that keeps world transform `w` once the object is placed under `parent` (undefined = scene root). */
export function localFromWorld(scene: any, parent: Obj | undefined, w: Xf): Xf {
  if (!parent) return w;
  const P = worldXf(scene, parent);
  const r = -P.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = w.x - P.x, dy = w.y - P.y;
  return { x: (c * dx - s * dy) / (P.sx || 1), y: (s * dx + c * dy) / (P.sy || 1), sx: w.sx / (P.sx || 1), sy: w.sy / (P.sy || 1), rot: w.rot - P.rot };
}

export type Place = "top" | "bottom" | number | { above: string | number } | { below: string | number };

/** Insert into objects[] (last = on top). */
/** parallaxDepth of a layer that must not move with the mouse (WE gives layers WITHOUT the key a non-zero depth once camera parallax is on) */
export const FIXED_DEPTH = "0.00000 0.00000";

export function insertAt(scene: any, obj: Obj, place: Place = "top"): void {
  if (scene.general?.cameraparallax && obj.parallaxDepth === undefined && !obj.sound) obj.parallaxDepth = FIXED_DEPTH;
  const objs: Obj[] = scene.objects;
  let i = objs.length;
  if (place === "bottom") i = 0;
  else if (typeof place === "number") i = Math.max(0, Math.min(objs.length, place));
  else if (typeof place === "object") {
    const ref = findLayer(scene, "above" in place ? place.above : place.below);
    const at = objs.indexOf(ref);
    i = "above" in place ? at + 1 : at;
  }
  objs.splice(i, 0, obj);
}

/** World position (scene units, y up) of a named anchor of a layer whose world transform is `w`. */
export function anchorPoint(w: Xf, size: number[], anchor: string): [number, number] {
  const a = ANCHORS[anchor];
  if (!a) throw new Error(`Unknown anchor "${anchor}". Use: ${Object.keys(ANCHORS).join(", ")}`);
  const dx = a[0] * (size[0] || 0) * w.sx, dy = a[1] * (size[1] || 0) * w.sy, r = w.rot * Math.PI / 180;
  return [w.x + Math.cos(r) * dx - Math.sin(r) * dy, w.y + Math.sin(r) * dx + Math.cos(r) * dy];
}

/** Write a local transform back to an object, keeping untouched fields (z of origin, angle x/y, scale z). */
export function setLocal(obj: Obj, l: Xf): void {
  obj.origin = vecStr([l.x, l.y, parseVec(obj.origin, [0, 0, 0])[2] ?? 0]);
  if (Math.abs(l.sx - 1) > 1e-6 || Math.abs(l.sy - 1) > 1e-6 || obj.scale !== undefined) obj.scale = vecStr([l.sx, l.sy, parseVec(obj.scale, [1, 1, 1])[2] ?? 1]);
  const an = parseVec(obj.angles, [0, 0, 0]);
  if (Math.abs(l.rot) > 1e-9 || obj.angles !== undefined) obj.angles = vecStr([an[0] ?? 0, an[1] ?? 0, l.rot * RAD]);
}
