import * as fs from "fs";
import * as path from "path";
import {
  Obj, SceneCtx, openScene, saveScene, nextId, sceneSize, findLayer, parseVec, vecStr, slug, colorStr, worldXf, bindable,
  insertAt, localFromWorld, Place, Xf, anchorPoint, setLocal, kindOf, anglesStr,
} from "../sceneio";
import { matchParam, ASSETS } from "../effects";
import { effectLabel, findEntry, findEffectInfo, installEffect } from "./fx";

/* ====================================================================
   Property animation (keyframes) - same schema the editor writes
   ==================================================================== */

interface Pt { frame: number; value: number }

/** smooth (Bezier) keyframe, or `linear` = the editor's "Toggle Bezier interpolation" switched off (constant speed between keyframes) */
const kf = (frame: number, value: number, linear = false) => ({
  back: { enabled: !linear, x: -1, y: 0 }, frame, front: { enabled: !linear, x: 1, y: 0 }, lockangle: !linear, locklength: !linear, value: +value.toFixed(6),
});

/** timeline options of the editor's animation dialog that are not derived from the wave */
export interface AnimOpts { linear?: boolean; name?: string; start_paused?: boolean; wrap_loop?: boolean }

export type WaveKind = "sine" | "triangle" | "pulse" | "noise" | "ramp";
interface WaveSpec {
  wave: WaveKind;
  period: number;
  amp: number[];
  phase: number[];
  mode: "loop" | "mirror" | "single";
  from?: number[]; to?: number[];
  keyframes?: { t: number; v: number[] }[];
  samples?: number;
}

const pick = (a: number[] | undefined, c: number, d = 0) => (a && a.length ? a[Math.min(c, a.length - 1)] : d);

function shape(kind: WaveKind, x: number, rnd: () => number): number {
  const t = x - Math.floor(x);
  switch (kind) {
    case "sine": return Math.sin(2 * Math.PI * x);
    case "triangle": return (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * x));
    case "pulse": return t < 0.08 ? t / 0.08 : Math.exp(-(t - 0.08) * 7); // quick attack, slow decay: 0..1
    default: return rnd() * 2 - 1;
  }
}

/** Keyframes per user channel. Loops are closed (last keyframe == first). */
export function waveChannels(n: number, w: WaveSpec): { ch: Pt[][]; length: number; fps: number } {
  const ch: Pt[][] = [];
  if (w.keyframes?.length) {
    const fps = 30, length = Math.max(1, Math.round(Math.max(...w.keyframes.map(k => k.t)) * fps));
    for (let c = 0; c < n; c++) ch.push(w.keyframes.map(k => ({ frame: Math.round(k.t * fps), value: pick(k.v, c) })));
    return { ch, length, fps };
  }
  if (w.wave === "ramp") {
    const length = 30;
    for (let c = 0; c < n; c++) ch.push([{ frame: 0, value: pick(w.from, c) }, { frame: length, value: pick(w.to, c) }]);
    return { ch, length, fps: length / w.period };
  }
  const N = w.samples ?? (w.wave === "pulse" ? 24 : w.wave === "noise" ? 12 : 16);
  for (let c = 0; c < n; c++) {
    let seed = 7 + c * 101;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const A = pick(w.amp, c), ph = pick(w.phase, c);
    const pts: Pt[] = [];
    for (let k = 0; k <= N; k++) pts.push({ frame: k, value: k === N && w.wave === "noise" ? pts[0].value : A * shape(w.wave, k / N + ph, rnd) });
    ch.push(pts);
  }
  return { ch, length: N, fps: N / w.period };
}

interface PropDef {
  /** number of user-facing channels */
  user: number;
  relative: boolean;
  /** raw channel i = user channel `c` * m (c = -1: constant 0) */
  raw: { c: number; m: number }[];
  unit: string;
}
const DEG = Math.PI / 180;
const PROPS: Record<string, PropDef> = {
  origin: { user: 2, relative: true, raw: [{ c: 0, m: 1 }, { c: 1, m: -1 }, { c: -1, m: 0 }], unit: "px (x right, y down)" },
  angles: { user: 1, relative: true, raw: [{ c: -1, m: 0 }, { c: -1, m: 0 }, { c: 0, m: DEG }], unit: "degrees (counter-clockwise +)" },
  scale: { user: 2, relative: true, raw: [{ c: 0, m: 1 }, { c: 1, m: 1 }, { c: -1, m: 0 }], unit: "scale delta" },
  alpha: { user: 1, relative: false, raw: [{ c: 0, m: 1 }], unit: "0..1" },
  brightness: { user: 1, relative: false, raw: [{ c: 0, m: 1 }], unit: "multiplier" },
  color: { user: 3, relative: false, raw: [{ c: 0, m: 1 }, { c: 1, m: 1 }, { c: 2, m: 1 }], unit: "0..1 rgb" },
};

function toAnimation(raw: PropDef["raw"], ch: Pt[][], length: number, fps: number, mode: string, add: number[] | undefined, relative: boolean, o: AnimOpts = {}) {
  const animation: any = { options: { fps: +fps.toFixed(6), length, mode } };
  if (o.name) animation.options.name = o.name;
  if (o.start_paused !== undefined) animation.options.startpaused = o.start_paused;
  if (o.wrap_loop !== undefined) animation.options.wraploop = o.wrap_loop;
  raw.forEach((r, i) => {
    const a = add ? add[i] ?? 0 : 0;
    const pts = r.c >= 0 && ch[r.c] ? ch[r.c].map(p => ({ frame: p.frame, value: p.value * r.m + a })) : [{ frame: 0, value: a }, { frame: length, value: a }];
    animation["c" + i] = pts.map(p => kf(p.frame, p.value, o.linear));
  });
  if (relative) animation.relative = true;
  return animation;
}

export const ANIM_PRESETS: Record<string, { property: string; wave: WaveKind; period: number; amplitude: number[]; pivot?: string; mode?: "loop" | "mirror" | "single"; note: string }> = {
  sway: { property: "angles", wave: "sine", period: 5, amplitude: [2], pivot: "bottom", note: "rotation about the base of the layer (a pivot group is created). amplitude = degrees." },
  float: { property: "origin", wave: "sine", period: 5, amplitude: [0, 12], note: "vertical bobbing. amplitude = px." },
  drift: { property: "origin", wave: "sine", period: 14, amplitude: [30, 0], note: "slow horizontal drift. amplitude = px." },
  breathe: { property: "scale", wave: "sine", period: 4, amplitude: [0.012, 0.012], pivot: "bottom", note: "gentle scale in/out about the base. amplitude = scale delta." },
  glow: { property: "alpha", wave: "sine", period: 3, amplitude: [0.25], note: "alpha oscillates around the current alpha (+-amplitude)." },
  flicker: { property: "brightness", wave: "noise", period: 1.2, amplitude: [0.25], note: "random brightness flicker (+-amplitude)." },
  spin: { property: "angles", wave: "ramp", period: 20, amplitude: [360], mode: "loop", note: "continuous rotation; amplitude = degrees per period (negative = reverse)." },
  fade_in: { property: "alpha", wave: "ramp", period: 3, amplitude: [1], mode: "single", note: "alpha 0 -> current value once." },
  fade_out: { property: "alpha", wave: "ramp", period: 3, amplitude: [1], mode: "single", note: "alpha current value -> 0 once." },
};

export interface AnimateArgs {
  preset?: string;
  property?: "origin" | "angles" | "scale" | "alpha" | "color" | "brightness";
  effect?: string | number; param?: string;
  wave?: WaveKind; amplitude?: number | number[]; period?: number; phase?: number | number[];
  from?: number | number[]; to?: number | number[];
  mode?: "loop" | "mirror" | "single";
  pivot?: string | { x: number; y: number };
  keyframes?: { t: number; value: number | number[] }[];
  /** named moments of the cycle (seconds); a script on the same layer gets them in animationEvent (add_script template event) */
  events?: { t: number; name: string }[];
  clear?: boolean;
  /** constant speed between keyframes instead of smooth curves (a cloud crossing the screen) */
  linear?: boolean;
  /** animation name: scripts reach it with thisLayer.getAnimation(name) (play / pause / setFrame) */
  name?: string;
  /** start paused: a script starts it (getAnimation(name).play()) */
  start_paused?: boolean;
  /** let Wallpaper Engine close the loop smoothly (use with custom keyframes; waves already close themselves) */
  wrap_loop?: boolean;
  /** layer property whose animation this one joins (same length, speed and mode; both play and pause together) */
  join?: "origin" | "angles" | "scale" | "alpha" | "color" | "brightness";
}

/** options.events = [{frame, name}] (what the editor's timeline markers save) */
function setEvents(animation: any, events: AnimateArgs["events"], length: number, fps: number): void {
  if (!events?.length) return;
  const dur = length / fps;
  for (const e of events) if (!e.name || !(e.t >= 0 && e.t <= dur)) throw new Error(`Event "${e.name}" at ${e.t} s: it needs a name and must fall inside the animation (0..${dur.toFixed(2)} s).`);
  animation.options.events = events.map(e => ({ frame: Math.round(e.t * fps), name: e.name }));
}

const arr = (v: number | number[] | undefined): number[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** Build the wave spec; a scalar amplitude keeps the preset's axis (e.g. float [0,12] + 20 -> [0,20]). */
function makeSpec(a: AnimateArgs, preset: (typeof ANIM_PRESETS)[string] | undefined, n: number, relative: boolean, base: number[]): WaveSpec {
  const wave = a.wave ?? preset?.wave ?? "sine";
  const period = a.period ?? preset?.period ?? 5;
  if (!(period > 0)) throw new Error("period must be > 0 seconds.");
  const mode = a.mode ?? preset?.mode ?? (wave === "ramp" ? "single" : "loop");
  let amp = arr(a.amplitude) ?? preset?.amplitude ?? [1];
  if (a.amplitude !== undefined && !Array.isArray(a.amplitude)) {
    const s = a.amplitude;
    amp = preset && preset.amplitude.length > 1 ? preset.amplitude.map(v => (v !== 0 ? s : 0)) : Array(n).fill(s);
  }
  const spec: WaveSpec = {
    wave, period, amp, phase: arr(a.phase) ?? [0], mode, from: arr(a.from), to: arr(a.to),
    keyframes: a.keyframes?.map(k => ({ t: k.t, v: arr(k.value) ?? [0] })),
  };
  if (wave === "ramp" && !spec.from && !spec.to && !spec.keyframes) {
    if (relative) { spec.from = Array(n).fill(0); spec.to = amp; }
    else { spec.from = base; spec.to = base.map((v, i) => v + pick(amp, i)); }
  }
  return spec;
}

/** Reuse "<layer> pivot" when it already exists, otherwise create a group at the pivot and re-parent the layer under it. */
export function pivotGroup(ctx: SceneCtx, layer: Obj, pivot: string | { x: number; y: number }): { group: Obj; created: boolean } {
  const { scene } = ctx;
  const existing = layer.parent !== undefined ? scene.objects.find((p: Obj) => p.id === layer.parent) : undefined;
  if (existing && kindOf(existing) === "group" && existing.name === `${layer.name} pivot`) return { group: existing, created: false };
  const cv = sceneSize(scene);
  const size = parseVec(layer.size, [0, 0]);
  const w = worldXf(scene, layer);
  const [px, py] = typeof pivot === "string" ? anchorPoint(w, size, pivot) : [pivot.x, cv.h - pivot.y];
  const gl = localFromWorld(scene, existing, { x: px, y: py, sx: 1, sy: 1, rot: 0 });
  const g: Obj = { id: nextId(scene), name: `${layer.name} pivot`, origin: vecStr([gl.x, gl.y, 0]) };
  if (existing) g.parent = existing.id;
  scene.objects.splice(scene.objects.indexOf(layer), 0, g);
  const ll = localFromWorld(scene, g, w);
  layer.parent = g.id;
  setLocal(layer, ll);
  return { group: g, created: true };
}

/** Unlink the animation of `property` from the ones it shares a timeline with: the properties that joined it go back to static, and it leaves the animation it joined. */
function detach(layer: Obj, property: string): void {
  const o = layer[property]?.animation?.options;
  for (const c of o?.children ?? []) if (layer[c.key]?.animation) layer[c.key] = layer[c.key].value;
  const par = o?.parent ? layer[o.parent.key]?.animation?.options : undefined;
  if (par?.children) { par.children = par.children.filter((c: any) => c.key !== property); if (!par.children.length) delete par.children; }
}

export function animateLayer(project: string, layerRef: string | number, a: AnimateArgs): string {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  let layer = findLayer(scene, layerRef);
  const preset = a.preset ? ANIM_PRESETS[a.preset] : undefined;
  if (a.preset && !preset) throw new Error(`Unknown preset "${a.preset}". Presets: ${Object.keys(ANIM_PRESETS).join(", ")}.`);

  /* ---- effect parameter ---- */
  if (a.effect !== undefined) {
    if (!a.param) throw new Error("param is required when animating an effect.");
    const idx = findEntry(layer, a.effect);
    const entry = layer.effects[idx];
    const info = findEffectInfo(effectLabel(entry), dir);
    if (!info) throw new Error(`Cannot read ${entry.file}.`);
    const pr = matchParam(info, a.param);
    if (!pr) throw new Error(`Unknown parameter "${a.param}". Valid: ${info.params.map(x => x.key).join(", ")}.`);
    const pass = entry.passes[pr.pass]; pass.constantshadervalues = pass.constantshadervalues ?? {};
    const cur0 = pass.constantshadervalues[pr.key];
    if (a.clear) { if (cur0?.animation) pass.constantshadervalues[pr.key] = cur0.value; saveScene(ctx); return `Cleared the animation of ${pr.key}.`; }
    const n = Number(/vec(\d)/.exec(pr.type)?.[1] ?? 1);
    const curV = parseVec(cur0 && typeof cur0 === "object" && "value" in cur0 ? cur0.value : cur0 ?? pr.default, [0]);
    const base = Array.from({ length: n }, (_, i) => pick(curV, i));
    const spec = makeSpec(a, preset, n, false, base);
    const { ch, length, fps } = waveChannels(n, spec);
    const raw = Array.from({ length: n }, (_, i) => ({ c: i, m: 1 }));
    const add = spec.keyframes || spec.wave === "ramp" ? undefined : base;
    if (a.join) throw new Error("join works between layer properties, not for effect parameters.");
    const anim = toAnimation(raw, ch, length, fps, spec.mode, add, false, a);
    setEvents(anim, a.events, length, fps);
    pass.constantshadervalues[pr.key] = { animation: anim, value: n === 1 ? base[0] : base.join(" ") };
    saveScene(ctx);
    return `Animated ${pr.key} of effect #${idx} (${info.ref}): ${spec.wave}, ${spec.mode}, ${(length / fps).toFixed(2)} s per cycle, around ${base.join(" ")}.`;
  }

  /* ---- layer property ---- */
  const property = a.property ?? preset?.property;
  const def = property ? PROPS[property] : undefined;
  if (!property || !def) throw new Error(`Give a preset or a property (${Object.keys(PROPS).join(", ")}).`);
  if (a.clear) {
    const cur = layer[property];
    detach(layer, property);
    if (cur?.animation) layer[property] = cur.value;
    saveScene(ctx);
    return `Cleared the ${property} animation on [${layer.id}] "${layer.name}".`;
  }
  const notes: string[] = [];
  const pivot = a.pivot ?? preset?.pivot;
  if (pivot && pivot !== "center") {
    if (property === "angles" || property === "scale") {
      const { group, created } = pivotGroup(ctx, layer, pivot);
      notes.push(`${created ? "Created" : "Reusing"} pivot group [${group.id}] "${group.name}" (${typeof pivot === "string" ? pivot + " of the layer" : `${pivot.x},${pivot.y} px`}); the group is animated, the layer follows it.`);
      layer = group;
    } else notes.push(`pivot ignored for ${property}.`);
  }
  const cur = layer[property];
  if (cur && typeof cur === "object" && "user" in cur) throw new Error(`${property} is bound to a user property; it cannot also be animated.`);
  const curRaw = cur && typeof cur === "object" && "value" in cur ? cur.value : cur;
  const dflt = property === "scale" ? [1, 1, 1] : property === "color" ? [1, 1, 1] : property === "alpha" || property === "brightness" ? [1] : [0, 0, 0];
  const baseRaw = parseVec(curRaw, dflt);
  const base = def.relative ? Array(def.user).fill(0) : baseRaw;
  const spec = makeSpec(a, preset, def.user, def.relative, base);
  if (a.preset === "fade_in" || a.preset === "fade_out") {
    const hi = baseRaw[0] > 0 ? baseRaw[0] : 1;
    [spec.from, spec.to] = a.preset === "fade_in" ? [[0], [hi]] : [[hi], [0]];
  }
  const { ch, length, fps } = waveChannels(def.user, spec);
  const add = def.relative || spec.keyframes || spec.wave === "ramp" ? undefined : baseRaw;
  const animation = toAnimation(def.raw, ch, length, fps, spec.mode, add, def.relative, a);
  setEvents(animation, a.events, length, fps);
  detach(layer, property); // re-animating a property that shared a timeline: the old links go
  if (a.join) {
    // the editor's "Bind timeline animation" of a second property to an existing animation: same options, `parent` here and `children` there
    const master = layer[a.join]?.animation;
    if (a.join === property || !master) throw new Error(`join: ${a.join} of [${layer.id}] "${layer.name}" needs its own animation first (animate_layer on ${a.join}), and must differ from ${property}.`);
    if (a.events?.length) throw new Error("events belong to the first (master) animation of the layer; put them there.");
    const { children: _c, name: _n, events: _e, ...mo } = master.options;
    const k = mo.length / length;
    for (const key of Object.keys(animation)) if (/^c\d+$/.test(key)) {
      const seen = new Set<number>();
      animation[key] = animation[key].map((f: any) => ({ ...f, frame: Math.round(f.frame * k) })).filter((f: any) => !seen.has(f.frame) && !!seen.add(f.frame));
    }
    animation.options = { ...mo, parent: { key: a.join } };
    (master.options.children ??= []).push({ key: property });
  }
  if (property === "alpha") for (const k of animation.c0) k.value = Math.max(0, Math.min(1, k.value));
  const staticValue = def.relative ? (typeof curRaw === "string" ? curRaw : vecStr(baseRaw.length === 3 ? baseRaw : dflt)) : curRaw ?? (property === "color" ? "1 1 1" : 1);
  layer[property] = { animation, value: staticValue };
  saveScene(ctx);
  return [
    `Animated ${property} of [${layer.id}] "${layer.name}": ${spec.wave}, ${spec.mode}, ${(length / fps).toFixed(2)} s per cycle, amplitude ${JSON.stringify(spec.amp)} ${def.unit}.`,
    ...notes,
    a.preset ? `Preset ${a.preset}: ${preset!.note}` : "",
    def.relative ? "Keyframes are offsets from the layer's static pose, so the pose you placed is the centre of the motion." : "",
    a.join ? `Joined the ${a.join} animation: one timeline (same length, speed and mode; the cycle was stretched to fit). Clearing ${a.join} clears this one too.` : "",
    a.linear ? "Linear: constant speed between keyframes." : "",
    a.name || a.start_paused ? `Animation${a.name ? ` "${a.name}"` : ""}${a.start_paused ? " starts paused" : ""}: script access thisLayer.getAnimation("${a.name ?? "<name>"}").play() / pause() / setFrame(n).` : "",
    a.events?.length ? `Events ${a.events.map(e => `${e.name}@${e.t}s`).join(", ")}: handle them with add_script template "event" (on this same layer) or custom code exporting animationEvent(event).` : "",
  ].filter(Boolean).join("\n");
}

/* ====================================================================
   Particles / effect-quad presets from the WE assets
   ==================================================================== */

const PRESETS = path.join(ASSETS, "presets");

function readLoose(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "").replace(/,\s*([}\]])/g, "$1"));
}

export interface PresetEntry { category: string; name: string; label: string; variant: any; dir: string; kind: "particle" | "shape" | "text" | "other" }

function loadPresets(): PresetEntry[] {
  if (!fs.existsSync(PRESETS)) return [];
  const out: PresetEntry[] = [];
  for (const cat of fs.readdirSync(PRESETS).sort()) {
    const f = path.join(PRESETS, cat, "preset.json");
    if (!fs.existsSync(f)) continue;
    let j: any; try { j = readLoose(f); } catch { continue; }
    for (const v of j.variants ?? []) {
      const o = v.objects?.[0];
      if (!o) continue;
      const kind = o.particle ? "particle" : o.shape ? "shape" : o.text !== undefined ? "text" : "other";
      const name = typeof o.particle === "string" ? path.basename(o.particle, ".json") : slug(`${cat}_${o.name ?? ""}`);
      out.push({ category: cat, name, label: String(o.name ?? ""), variant: v, dir: path.join(PRESETS, cat), kind });
    }
  }
  return out;
}

export function listParticles(query?: string): string {
  const q = query?.toLowerCase();
  const list = loadPresets().filter(p => p.kind !== "text" && (!q || `${p.category} ${p.name} ${p.label}`.toLowerCase().includes(q)));
  const by = new Map<string, PresetEntry[]>();
  for (const p of list) (by.get(p.category) ?? by.set(p.category, []).get(p.category)!).push(p);
  const out = [`Particle / light presets (${list.length}). Use add_particles preset:"<category>/<name>":`];
  for (const [c, ps] of by) out.push(`  ${c}: ${ps.map(p => `${p.name}${p.kind === "shape" ? " (light quad)" : ""}${p.label && slug(p.label) !== p.name ? ` ["${p.label}"]` : ""}`).join(", ")}`);
  return out.join("\n");
}

export interface ParticleArgs {
  preset: string; name?: string; x?: number; y?: number; scale?: number | number[]; rotation?: number;
  parent?: string | number; position?: Place; visible?: any; parallax_depth?: number | number[];
  /** multipliers of the preset (1 = unchanged) */
  count?: any; rate?: any; size?: any; speed?: any; lifetime?: any; alpha?: any; brightness?: any; color?: any;
  // (each is a plain value or a {property,...} user property so the viewer can tune it)
  /** another particle file shipped with the preset (e.g. spark/spark file:"sparktrails" = a burst of sparks) */
  file?: string;
  /** JSON merged into a project copy of the particle file: objects by key, arrays by index (null = keep): {emitter:[{rate:200,instantaneous:0}]} */
  patch?: Record<string, any>;
}

function mergeDeep(t: any, s: any): any {
  const obj = (v: any) => v && typeof v === "object";
  if (Array.isArray(s) && Array.isArray(t)) { s.forEach((v, i) => { if (v !== null) t[i] = obj(v) && obj(t[i]) ? mergeDeep(t[i], v) : v; }); return t; }
  if (obj(s) && obj(t)) { for (const k of Object.keys(s)) t[k] = obj(s[k]) && obj(t[k]) ? mergeDeep(t[k], s[k]) : s[k]; return t; }
  return s;
}

function findPreset(preset: string): PresetEntry {
  const q = preset.toLowerCase().trim();
  const [cat, nm] = q.includes("/") ? q.split("/") : [undefined, q];
  const all = loadPresets().filter(p => p.kind !== "text");
  let hits = all.filter(p => (!cat || p.category === cat) && (p.name.toLowerCase() === nm || slug(p.label) === slug(nm)));
  if (!hits.length) hits = all.filter(p => (!cat || p.category === cat) && (p.name.toLowerCase().includes(nm) || p.label.toLowerCase().includes(nm)));
  if (!hits.length) throw new Error(`Preset "${preset}" not found. Use list_particles to browse.`);
  if (hits.length > 1) throw new Error(`"${preset}" is ambiguous: ${hits.map(h => h.category + "/" + h.name).join(", ")}.`);
  return hits[0];
}

/** `custom` = a particle file already written to the project (create_particles): placed like a preset, nothing to look up or copy. */
export function addParticles(project: string, a: ParticleArgs, custom?: PresetEntry): string {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  const cv = sceneSize(scene);
  const pr = custom ?? findPreset(a.preset);
  const copied: string[] = [];
  for (const d of pr.variant.dependencies ?? []) {
    if (typeof d !== "string") continue;
    const src = path.join(pr.dir, d), dst = path.join(dir, d);
    if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); copied.push(d); }
  }
  let id = nextId(scene);
  const obj: Obj = { ...JSON.parse(JSON.stringify(pr.variant.objects[0])), id: id++ };
  const renum = (v: any) => { if (Array.isArray(v)) v.forEach(renum); else if (v && typeof v === "object") { for (const k in v) { if (k === "id" && typeof v.id === "number") v.id = id++; else renum(v[k]); } } };
  if (obj.effects) {
    renum(obj.effects);
    for (const e of obj.effects) { const info = findEffectInfo(effectLabel(e), dir); if (info) installEffect(dir, info); }
  }
  if (a.file || a.patch) {
    const files: string[] = (pr.variant.dependencies ?? []).filter((d: any) => typeof d === "string" && /^particles\/.*\.json$/i.test(d));
    const rel0 = a.file ? files.find(d => path.basename(d, ".json") === a.file) : obj.particle;
    if (!rel0) throw new Error(`"${a.file}" is not a particle file of ${pr.category}/${pr.name}. Available: ${files.map(d => path.basename(d, ".json")).join(", ")}.`);
    obj.particle = rel0;
    if (a.patch) {
      const j = mergeDeep(readLoose(path.join(dir, rel0)), a.patch), rel = rel0.replace(/\.json$/, `_${obj.id}.json`);
      fs.writeFileSync(path.join(dir, rel), JSON.stringify(j, null, "\t"));
      obj.particle = rel;
    }
  }
  const io: Record<string, any> = { ...(obj.instanceoverride ?? {}) };
  for (const k of ["count", "rate", "size", "speed", "lifetime", "alpha", "brightness"] as const) if (a[k] !== undefined) io[k] = bindable(dir, a[k], 1);
  if (a.color) io.colorn = typeof a.color === "string" || Array.isArray(a.color) ? colorStr(a.color) : bindable(dir, a.color, "1 1 1");
  if (Object.keys(io).length) { io.id = id++; obj.instanceoverride = io; }
  const parent = a.parent !== undefined ? findLayer(scene, a.parent) : undefined;
  const sc = Array.isArray(a.scale) ? a.scale : [a.scale ?? 1, a.scale ?? 1];
  const l = localFromWorld(scene, parent, { x: a.x ?? cv.w / 2, y: cv.h - (a.y ?? cv.h / 2), sx: sc[0], sy: sc[1] ?? sc[0], rot: a.rotation ?? 0 });
  obj.origin = vecStr([l.x, l.y, 0]); obj.angles = anglesStr(l.rot); obj.scale = vecStr([l.sx, l.sy, 1]);
  obj.name = a.name ?? (pr.label || pr.name);
  obj.solid = true;
  if (parent) obj.parent = parent.id;
  if (a.parallax_depth !== undefined) { const pd = Array.isArray(a.parallax_depth) ? a.parallax_depth : [a.parallax_depth, a.parallax_depth]; obj.parallaxDepth = vecStr(pd.slice(0, 2)); }
  if (a.visible !== undefined && a.visible !== true) obj.visible = bindable(dir, a.visible, true);
  insertAt(scene, obj, a.position ?? "top");
  saveScene(ctx);
  return [
    `Added ${pr.kind === "shape" ? "light quad" : "particle system"} [${obj.id}] "${obj.name}" (${custom ? "from scratch" : `preset ${pr.category}/${pr.name}`}) at (${a.x ?? cv.w / 2}, ${a.y ?? cv.h / 2}) px.`,
    copied.length ? `Copied: ${copied.join(", ")}` : "",
    Object.keys(io).length ? `Overrides: ${JSON.stringify(io)}` : "",
    "Presets emit relative to their origin in scene space; scale the object to grow the emission area. Particles are only marked in preview_scene - apply the wallpaper to see them.",
  ].filter(Boolean).join("\n");
}
