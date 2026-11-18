import * as fs from "fs";
import * as path from "path";
import { WE_PATH, WORKSHOP_PATH } from "./config";
import { colorStr } from "./sceneio";

export const ASSETS = path.join(WE_PATH, "assets");
export const BUILTIN_EFFECTS = path.join(ASSETS, "effects");

/* ---------------- shader annotation parsing ---------------- */

export interface ParamInfo {
  key: string; label: string; type: string; default?: any; range?: [number, number];
  group?: string; direction?: boolean; color?: boolean; linked?: boolean; pass: number;
}
export interface SamplerInfo { slot: number; role: string; label: string; mode?: string; combo?: string; default?: string; hidden?: boolean; pass: number }
export interface ComboInfo { combo: string; label: string; default: number; options?: Record<string, number>; pass: number }
export interface EffectInfo {
  ref: string;               // value to use with add_effect ("shake", "workshop/2138904733/cutout_vignette")
  file: string;              // value stored in scene.json ("effects/shake/effect.json")
  title: string; group: string; description: string; performance?: string;
  passCount: number; params: ParamInfo[]; samplers: SamplerInfo[]; combos: ComboInfo[];
  builtin: boolean; root: string;
}

export const humanize = (s: string) => s.replace(/^ui_(editor_)?(properties_|effect_)?/, "").replace(/_(title|description)$/, "").replace(/_/g, " ").trim();

function tryJson(s: string): any { try { return JSON.parse(s); } catch { return undefined; } }

function readText(p: string): string | null { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } }

function parseShader(text: string, pass: number, out: { params: ParamInfo[]; samplers: SamplerInfo[]; combos: ComboInfo[] }) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^\/\/\s*\[COMBO\]\s*(\{.*\})/.exec(line);
    if (m) {
      const j = tryJson(m[1]);
      if (j?.combo && !out.combos.some(c => c.combo === j.combo && c.pass === pass))
        out.combos.push({ combo: j.combo, label: humanize(String(j.material ?? j.combo)), default: Number(j.default ?? 0), options: j.options, pass });
      continue;
    }
    m = /^uniform\s+(\w+)\s+(\w+)(?:\[[^\]]*\])?\s*;\s*\/\/\s*(\{.*\})/.exec(line);
    if (!m) continue;
    const [, type, name, json] = m;
    const j = tryJson(json);
    if (!j) continue;
    if (type === "sampler2D") {
      const slot = Number(/g_Texture(\d+)/.exec(name)?.[1] ?? -1);
      if (slot < 0 || out.samplers.some(s => s.slot === slot && s.pass === pass)) continue;
      const mode = j.mode as string | undefined;
      const role = j.combo === "TIMEOFFSET" || /time_offset/.test(j.label ?? "") ? "timeoffset"
        : mode === "flowmask" ? "flow" : mode === "opacitymask" ? "opacity" : j.hidden ? "hidden" : mode ?? "texture";
      out.samplers.push({ slot, role, label: humanize(String(j.label ?? name)), mode, combo: j.combo, default: j.default, hidden: j.hidden, pass });
    } else if (j.material && !out.params.some(p => p.key === j.material && p.pass === pass)) {
      out.params.push({
        key: String(j.material), label: humanize(String(j.label ?? j.material)), type: j.type === "color" ? "color" : type,
        default: j.default, range: Array.isArray(j.range) ? [Number(j.range[0]), Number(j.range[1])] : undefined,
        group: j.group ? humanize(String(j.group)) : undefined, direction: !!j.direction, color: j.type === "color", linked: !!j.linked, pass,
      });
    }
  }
}

const cache = new Map<string, EffectInfo | null>();
/** Drop a cached description after its files were rewritten (create_effect). */
export const forgetEffect = (effectJson: string) => cache.delete(effectJson);

function loadFrom(ref: string, effectJson: string, root: string, builtin: boolean): EffectInfo | null {
  const key = effectJson;
  if (cache.has(key)) return cache.get(key)!;
  const txt = readText(effectJson);
  const def = txt ? tryJson(txt) : undefined;
  if (!def) { cache.set(key, null); return null; }
  const out = { params: [] as ParamInfo[], samplers: [] as SamplerInfo[], combos: [] as ComboInfo[] };
  const passes: any[] = Array.isArray(def.passes) ? def.passes : [];
  passes.forEach((p, i) => {
    if (!p.material) return;
    const mat = tryJson(readText(path.join(root, p.material)) ?? "");
    const shader: string | undefined = mat?.passes?.[0]?.shader;
    if (!shader) return;
    for (const ext of [".frag", ".vert"]) {
      const t = readText(path.join(root, "shaders", shader + ext)) ?? readText(path.join(ASSETS, "shaders", shader + ext));
      if (t) parseShader(t, i, out);
    }
    // defaults baked into the material override shader defaults
    const csv = mat?.passes?.[0]?.constantshadervalues;
    if (csv) for (const pr of out.params) if (pr.pass === i && csv[pr.key] !== undefined) pr.default = csv[pr.key];
  });
  const rel = path.relative(builtin ? BUILTIN_EFFECTS : root, effectJson).split(path.sep).join("/");
  const info: EffectInfo = {
    ref, file: builtin ? `effects/${rel}` : rel,
    title: def.name && !String(def.name).startsWith("ui_") ? String(def.name) : humanize(String(def.name ?? ref)),
    group: String(def.group ?? ""), description: def.description && !String(def.description).startsWith("ui_") ? String(def.description) : "",
    performance: def.performance, passCount: passes.length, ...out, builtin, root,
  };
  cache.set(key, info);
  return info;
}

/** Find an effect. `projectDir` is needed for project-local effects ("workshop/<id>/<name>"). */
export function loadEffect(ref: string, projectDir?: string): EffectInfo | null {
  const clean = ref.replace(/^effects\//, "").replace(/\/effect\.json$/, "");
  const builtin = path.join(BUILTIN_EFFECTS, clean, "effect.json");
  if (!clean.includes("..") && fs.existsSync(builtin)) return loadFrom(clean, builtin, path.join(BUILTIN_EFFECTS, clean), true);
  if (projectDir) {
    const local = path.join(projectDir, "effects", clean, "effect.json");
    if (!clean.includes("..") && fs.existsSync(local)) return loadFrom(clean, local, projectDir, false);
  }
  return null;
}

/** Describe a Workshop effect in place (without installing it into a project). */
export function loadWorkshopEffect(id: string, name: string): EffectInfo | null {
  const item = WORKSHOP_PATH ? path.join(WORKSHOP_PATH, id) : "";
  const ej = path.join(item, "effects", name, "effect.json");
  const safe = /^\d+$/.test(id) && /^[\w.-]+$/.test(name) && name !== "..";
  return item && safe && fs.existsSync(ej) ? loadFrom(`workshop/${id}/${name}`, ej, item, false) : null;
}

export function listBuiltinEffects(): EffectInfo[] {
  if (!fs.existsSync(BUILTIN_EFFECTS)) return [];
  return fs.readdirSync(BUILTIN_EFFECTS).sort()
    .map(n => (fs.existsSync(path.join(BUILTIN_EFFECTS, n, "effect.json")) ? loadEffect(n) : null))
    .filter((e): e is EffectInfo => !!e && e.passCount > 0);
}

/* ---------------- workshop effects ---------------- */

export interface WorkshopEffect { id: string; title: string; dir: string; effects: string[] }

/** Workshop items that ship plain effects (item/effects/<name>/effect.json). */
export function listWorkshopEffects(): WorkshopEffect[] {
  if (!WORKSHOP_PATH || !fs.existsSync(WORKSHOP_PATH)) return [];
  const res: WorkshopEffect[] = [];
  for (const id of fs.readdirSync(WORKSHOP_PATH)) {
    const dir = path.join(WORKSHOP_PATH, id);
    const eff = path.join(dir, "effects");
    if (!fs.existsSync(eff) || !fs.statSync(eff).isDirectory()) continue;
    const names = fs.readdirSync(eff).filter(n => fs.existsSync(path.join(eff, n, "effect.json")));
    if (!names.length) continue;
    const pj = tryJson(readText(path.join(dir, "project.json")) ?? "") ?? {};
    res.push({ id, title: String(pj.title ?? id), dir, effects: names });
  }
  return res;
}

/**
 * Install a Workshop effect into a project the way the editor does:
 *   effects/workshop/<id>/<name>/effect.json, materials/workshop/<id>/effects/*.json, shaders/workshop/<id>/effects/*
 * Returns the effect refs ("workshop/<id>/<name>").
 */
export function installWorkshopEffect(projectDir: string, workshopId: string, only?: string): string[] {
  if (!/^\d+$/.test(workshopId) || (only !== undefined && !/^[\w.-]+$/.test(only))) throw new Error("Workshop id must be numeric and the effect name a plain folder name.");
  const item = WORKSHOP_PATH ? path.join(WORKSHOP_PATH, workshopId) : "";
  if (!item || !fs.existsSync(path.join(item, "effects"))) throw new Error(`Workshop item ${workshopId} has no effects (is it subscribed and downloaded?).`);
  const title = tryJson(readText(path.join(item, "project.json")) ?? "")?.title;
  const refs: string[] = [];
  const names = fs.readdirSync(path.join(item, "effects")).filter(n => fs.existsSync(path.join(item, "effects", n, "effect.json")));
  for (const name of names) {
    if (only && name !== only) continue;
    const src = path.join(item, "effects", name);
    const def = tryJson(readText(path.join(src, "effect.json")) ?? "");
    if (!def) continue;
    const deps: string[] = [];
    const rewriteMat = (m: string) => {
      const base = path.posix.basename(m);
      deps.push(`materials/workshop/${workshopId}/effects/${base}`);
      return `materials/workshop/${workshopId}/effects/${base}`;
    };
    const passes = (def.passes ?? []).map((p: any) => ({ ...p, material: p.material ? rewriteMat(p.material) : p.material }));
    // copy materials + shaders
    const copyDir = (from: string, toRel: string, rewrite?: (txt: string) => string) => {
      if (!fs.existsSync(from)) return;
      for (const f of fs.readdirSync(from)) {
        const dest = path.join(projectDir, toRel, f);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (rewrite && f.endsWith(".json")) fs.writeFileSync(dest, rewrite(fs.readFileSync(path.join(from, f), "utf-8")));
        else fs.copyFileSync(path.join(from, f), dest);
        if (!f.endsWith(".json")) deps.push(`${toRel}/${f}`.split(path.sep).join("/"));
      }
    };
    copyDir(path.join(src, "materials", "effects"), `materials/workshop/${workshopId}/effects`,
      txt => txt.replace(/"shader"\s*:\s*"(?:workshop\/\d+\/)?(effects\/[^"]+)"/g, `"shader" : "workshop/${workshopId}/$1"`));
    copyDir(path.join(src, "shaders", "effects"), `shaders/workshop/${workshopId}/effects`);
    const outDef = {
      ...def, passes, editable: false, group: "localeffects", name: def.name && !String(def.name).startsWith("ui_") ? def.name : (title ?? name),
      dependencies: [...new Set(deps)],
    };
    const destDir = path.join(projectDir, "effects", "workshop", workshopId, name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "effect.json"), JSON.stringify(outDef, null, "\t"));
    refs.push(`workshop/${workshopId}/${name}`);
  }
  if (!refs.length) throw new Error(`Effect "${only}" not found in workshop item ${workshopId}.`);
  return refs;
}

/* ---------------- value handling ---------------- */

const canon = (s: string) => s.toLowerCase().replace(/^ui_editor_properties_/, "").replace(/[^a-z0-9]/g, "");

/** Map a user-supplied key to a parameter (exact key, then loose match on key or label). */
export function matchParam(info: EffectInfo, key: string): ParamInfo | undefined {
  const exact = info.params.find(p => p.key === key);
  if (exact) return exact;
  const c = canon(key);
  return info.params.find(p => canon(p.key) === c) ?? info.params.find(p => canon(p.label) === c);
}

/** Convert a JS value to the string/number format scene.json expects for this parameter. */
export function formatValue(p: ParamInfo, v: any): any {
  if (v && typeof v === "object" && !Array.isArray(v) && ("user" in v || "script" in v)) return v; // binding / script: pass through
  if (p.color && (typeof v === "string" || Array.isArray(v))) return colorStr(v); // "#rrggbb" / [r,g,b] / "r g b" -> "r g b" (0-1)
  const vec = /vec(\d)/.exec(p.type);
  if (typeof v === "string" && /^-?[\d.]+deg$/i.test(v)) v = parseFloat(v) * Math.PI / 180;
  if (vec) {
    const n = Number(vec[1]);
    let a: number[];
    if (Array.isArray(v)) a = v.map(Number);
    else if (typeof v === "string") a = v.trim().split(/[\s,]+/).map(Number);
    else a = Array(n).fill(Number(v));
    if (a.length === 1) a = Array(n).fill(a[0]);
    if (a.length !== n || a.some(x => !Number.isFinite(x))) throw new Error(`"${p.key}" needs ${n} numbers (got ${JSON.stringify(v)}).`);
    return a.join(" ");
  }
  if (p.type === "float" || p.type === "int" || p.type === "uint") {
    const x = Number(v);
    if (!Number.isFinite(x)) throw new Error(`"${p.key}" must be a number (got ${JSON.stringify(v)}).`);
    return x;
  }
  return v;
}

/** Texture slot for a mask role (opacity/flow/timeoffset) in a given effect, or undefined. */
export function samplerFor(info: EffectInfo, role: "opacity" | "flow" | "timeoffset"): SamplerInfo | undefined {
  const c = info.samplers.filter(s => s.role === role);
  return c.find(s => s.combo === "MASK") ?? c.find(s => !!s.combo) ?? c[0];
}

export function describeEffect(e: EffectInfo): string {
  const lines: string[] = [];
  lines.push(`${e.ref}  "${e.title}"  [${e.group || "-"}${e.performance ? ", " + e.performance : ""}]  passes: ${e.passCount}  ${e.builtin ? "(built-in)" : "(project-local)"}`);
  if (e.description) lines.push(`  ${e.description}`);
  lines.push("  Parameters (key = default, range) - use these keys in add_effect values:");
  for (const p of e.params) {
    const flags = [p.direction ? "angle in radians (or \"45deg\")" : "", p.color ? "colour 0-1" : "", p.linked ? "linked xy" : "", e.passCount > 1 ? `pass ${p.pass}` : ""].filter(Boolean).join(", ");
    lines.push(`    ${p.key} (${p.type}) = ${JSON.stringify(p.default)}${p.range ? ` range ${p.range[0]}..${p.range[1]}` : ""}${flags ? "  [" + flags + "]" : ""}  - ${p.label}${p.group ? ` / ${p.group}` : ""}`);
  }
  const roles = e.samplers.filter(s => s.role !== "hidden" && s.slot > 0);
  if (roles.length) {
    lines.push("  Masks / textures (use add_effect masks: { opacity | flow | timeoffset }):");
    for (const s of roles) lines.push(`    slot ${s.slot}: ${s.role}  - ${s.label}${s.combo ? ` (enables ${s.combo})` : ""}`);
  }
  if (e.combos.length) {
    lines.push("  Combos (use add_effect combos):");
    for (const c of e.combos) lines.push(`    ${c.combo} = ${c.default}${c.options ? " options " + JSON.stringify(c.options) : ""}  - ${c.label}`);
  }
  return lines.join("\n");
}
