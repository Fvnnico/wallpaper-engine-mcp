import * as fs from "fs";
import * as path from "path";
import { ASSETS } from "../effects";
import { colorStr, openScene } from "../sceneio";
import { ParticleArgs, addParticles } from "./anim";
import { importTexture } from "./scene";

/* ====================================================================
   A particle system from scratch: particles/<name>.json + its material, then placed like a preset.
   Component names and keys are the ones WE stores (surveyed over every installed particle file).
   ==================================================================== */

export const PARTICLE_COMPONENTS = {
  emitter: ["boxrandom", "sphererandom", "layerimage"],
  initializer: ["alpharandom", "angularvelocityrandom", "colorlist", "colorrandom", "hsvcolorrandom", "inheritcontrolpointvelocity", "inheritinitialvaluefromevent", "lifetimerandom", "mapsequencearoundcontrolpoint", "mapsequencebetweencontrolpoints", "positionoffsetrandom", "remapinitialvalue", "rotationrandom", "sizerandom", "turbulentvelocityrandom", "velocityrandom"],
  operator: ["alphachange", "alphafade", "angularmovement", "boids", "capvelocity", "collisionbounds", "collisionmodel", "collisionplane", "collisionquad", "collisionsphere", "colorchange", "controlpointattract", "inheritvaluefromevent", "maintaindistancebetweencontrolpoints", "maintaindistancetocontrolpoint", "movement", "oscillatealpha", "oscillateposition", "oscillatesize", "reducemovementnearcontrolpoint", "remapvalue", "sizechange", "turbulence", "vortex", "vortex_v2"],
  renderer: ["sprite", "spritetrail", "rope", "ropetrail"],
} as const;
type Cat = keyof typeof PARTICLE_COMPONENTS;
export const CHILD_TYPES = ["static", "eventfollow", "eventspawn", "eventdeath"] as const;

type Comp = { name: string; [k: string]: any };
interface ControlPoint { pointer?: boolean; offset?: number[] | string; worldspace?: boolean; parent?: number }
interface Child {
  type?: (typeof CHILD_TYPES)[number]; system?: ParticleBody; file?: string; maxcount?: number; probability?: number;
  origin?: number[] | string; angles?: number[] | string; scale?: number[] | string; set_control_points?: number;
}
export interface ParticleBody {
  texture?: string; blending?: "additive" | "translucent" | "normal";
  maxcount?: number; starttime?: number; flags?: number;
  emitter?: Comp[]; initializer?: Comp[]; operator?: Comp[]; renderer?: Comp[];
  control_points?: Record<string, ControlPoint>; children?: Child[];
}
export interface CreateParticlesArgs extends ParticleBody, Omit<ParticleArgs, "preset"> { name: string }

// what an empty category gets, so create_particles {name} already shows something
const DEFAULTS: Record<Cat, Comp[]> = {
  emitter: [{ name: "sphererandom", rate: 30, distancemax: 100 }],
  initializer: [{ name: "lifetimerandom", min: 2, max: 4 }, { name: "sizerandom", min: 20, max: 60 }, { name: "velocityrandom", min: [-30, -30, 0], max: [30, 30, 0] }],
  operator: [{ name: "movement" }, { name: "alphafade", fadeintime: 0.2, fadeouttime: 0.5 }],
  renderer: [{ name: "sprite" }],
};

const vec = (v: any) => (Array.isArray(v) ? v.join(" ") : v);
const rgb255 = (c: any) => colorStr(c).split(" ").map(x => Math.round(Number(x) * 255)).join(" ");

/** One component as WE stores it: vectors "x y z", colours in the unit each key uses (colorrandom 0-255, colorchange / colorlist 0-1), a fresh id. */
function component(cat: Cat, c: Comp, id: () => number): any {
  if (!c || typeof c.name !== "string" || !(PARTICLE_COMPONENTS[cat] as readonly string[]).includes(c.name))
    throw new Error(`${cat} "${c?.name}" is not a Wallpaper Engine component. Valid: ${PARTICLE_COMPONENTS[cat].join(", ")}.`);
  const out: any = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === "id") continue;
    out[k] = c.name === "colorrandom" && (k === "min" || k === "max") ? rgb255(v)
      : c.name === "colorchange" && (k === "startvalue" || k === "endvalue") ? colorStr(v)
      : c.name === "colorlist" && k === "colors" ? (v as any[]).map(x => colorStr(x))
      : vec(v);
  }
  out.id = id();
  return out;
}

async function writeSystem(dir: string, base: string, b: ParticleBody): Promise<string> {
  let n = 0;
  const id = () => ++n;
  const sys: any = {};
  for (const cat of ["renderer", "initializer", "emitter", "operator"] as Cat[]) {
    const list = b[cat]?.length ? b[cat]! : DEFAULTS[cat];
    sys[cat] = list.map(c => component(cat, c, id));
  }
  if (!(b.maxcount === undefined || (Number.isInteger(b.maxcount) && b.maxcount >= 1))) throw new Error("maxcount must be a whole number >= 1 (keep it as low as the effect allows: it is allocated memory).");
  sys.maxcount = b.maxcount ?? 500;
  sys.starttime = b.starttime ?? 0;
  if (b.flags !== undefined) sys.flags = b.flags;

  sys.controlpoint = Array.from({ length: 8 }, (_, i) => {
    const s = b.control_points?.[String(i)];
    const o: any = { flags: 0, id: i, offset: vec(s?.offset) ?? "0 0 0" };
    if (s?.pointer) { o.flags |= 1; o.locktopointer = true; }
    if (s?.worldspace) o.flags |= 2;
    if (s?.parent !== undefined) { o.flags |= 4; o.parentcontrolpoint = s.parent; }
    return o;
  });
  for (const k of Object.keys(b.control_points ?? {})) if (!/^[0-7]$/.test(k)) throw new Error(`control_points keys are 0..7 (got "${k}"; point 0 is always the system origin, use 1+ for the mouse).`);

  // material: the stock particle texture, a texture of the project, or an image imported as .tex
  let tex = b.texture ?? "particle/halo";
  if (path.isAbsolute(tex)) tex = (await importTexture(dir, tex, base)).base;
  else if (!fs.existsSync(path.join(ASSETS, "materials", tex + ".tex")) && !fs.existsSync(path.join(dir, "materials", tex + ".tex")))
    throw new Error(`Texture "${tex}" not found: use a stock one ("particle/halo", "particle/shape/star_4", "particle/smoke/smoke1"... = assets/materials/particle/*.tex), a texture of the project, or an absolute image path.`);
  const matRel = `materials/particle/${base}.json`;
  fs.mkdirSync(path.join(dir, "materials", "particle"), { recursive: true });
  fs.writeFileSync(path.join(dir, matRel), JSON.stringify({ passes: [{ blending: b.blending ?? "additive", cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled", shader: "genericparticle", textures: [tex] }] }, null, "\t"));
  sys.material = matRel;

  sys.children = [];
  for (const [i, c] of (b.children ?? []).entries()) {
    if (!c.file === !c.system) throw new Error(`children[${i}]: give either file (a particle file of the project) or system (an inline system, same fields as the parent).`);
    if (c.type && !CHILD_TYPES.includes(c.type)) throw new Error(`children[${i}].type: ${CHILD_TYPES.join(", ")}.`);
    const name = c.file ?? await writeSystem(dir, `${base}_c${i + 1}`, { texture: tex, blending: b.blending, ...c.system });   // a child looks like its parent unless told otherwise
    if (!fs.existsSync(path.join(dir, name))) throw new Error(`children[${i}]: "${name}" not found in the project.`);
    const o: any = { id: id(), name, type: c.type ?? "static" };
    for (const k of ["maxcount", "probability"] as const) if (c[k] !== undefined) o[k] = c[k];
    for (const k of ["origin", "angles", "scale"] as const) if (c[k] !== undefined) o[k] = vec(c[k]);
    if (c.set_control_points !== undefined) { o.flags = 1; o.controlpointstartindex = c.set_control_points; }
    sys.children.push(o);
  }
  if (!sys.children.length) sys.children = null;

  const rel = `particles/${base}.json`;
  fs.mkdirSync(path.join(dir, "particles"), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(sys, null, "\t"));
  return rel;
}

export async function createParticles(project: string, a: CreateParticlesArgs): Promise<string> {
  const { dir } = openScene(project);
  if (!/^[a-z][a-z0-9_]*$/.test(a.name)) throw new Error(`Particle name "${a.name}": lower-case letters, digits and _ only (it names the files).`);
  let base = a.name;
  for (let i = 2; fs.existsSync(path.join(dir, "particles", base + ".json")); i++) base = `${a.name}_${i}`;
  const { name, emitter, initializer, operator, renderer, texture, blending, maxcount, starttime, flags, control_points, children, ...place } = a;
  const rel = await writeSystem(dir, base, { emitter, initializer, operator, renderer, texture, blending, maxcount, starttime, flags, control_points, children });
  const entry = { category: "custom", name: base, label: name, kind: "particle" as const, dir, variant: { objects: [{ particle: rel }], dependencies: [] } };
  const text = addParticles(project, { ...place, preset: "custom", name }, entry);
  return [text, `Particle file: ${rel}${(children?.length ?? 0) ? ` (+ ${children!.length} child system(s) as ${base}_c*.json)` : ""}. Particles are not drawn by preview_scene: judge it with capture_wallpaper (cursor:{x,y} tests a control point locked to the mouse).`].join("\n");
}
