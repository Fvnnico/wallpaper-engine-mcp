import * as fs from "fs";
import * as path from "path";
import { ASSETS } from "../effects";
import { MdlAttach, MdlBone, MdlVertex, writeMdl } from "../mdl";
import { layerTexture, readJson } from "../render";
import { anglesStr, findLayer, kindOf, localFromWorld, openScene, parseVec, saveScene, sceneSize, setLocal, slug, utilKind, vecStr, worldXf } from "../sceneio";
import { updateProperties } from "./properties";
import { SProp, addScript, header } from "./script";

/*
 * add_puppet: turn an image layer into a skinned puppet (Wallpaper Engine's puppet warp, without the editor).
 * Mesh = a grid over the picture's opaque part, skinning = the two nearest bones by distance to their segment, motion = ONE SceneScript on the
 * layer that sets the local bone angles every frame (`thisLayer.setLocalBoneAngles`, radians: verified live), with switches and sliders.
 * ponytail: grid mesh and distance weights - edges are as coarse as one cell, joints blend by 1/d^2. Upgrade: contour-fitted triangulation, heat weights.
 */

export interface PuppetBoneArg {
  name: string;
  /** joint position, canvas px (TOP-LEFT origin, y down) */
  x: number; y: number;
  /** an EARLIER bone (omitted = root) */
  parent?: string;
  /** idle sway amplitude of this bone in degrees (default: the `sway` argument) */
  sway?: number;
  /** degrees it leans toward the mouse at the screen edge (default: the `lean` argument) */
  lean?: number;
  /** simulate this bone (default: every bone with a parent when `physics` is set); a physics bone has no sway of its own unless `sway` is given */
  physics?: boolean;
}
/** Wallpaper Engine bone physics (Bone Constraints): the bone follows its parent's movement with inertia, like hair or a rope. */
export interface PuppetPhysics {
  /** spring returns to the rest pose (default), rigid keeps the last pose and only drags */
  mode?: "spring" | "rigid";
  /** spring only: how hard it returns (default 300) */
  stiffness?: number;
  /** damping, higher = calmer (default 12) */
  friction?: number;
  /** higher = reacts less to fast movement of the parent (default 30) */
  inertia?: number;
  /** tip mass, higher = gravity wins over movement (default 20) */
  mass?: number;
  /** pull the bone down (default false) */
  gravity?: boolean;
  /** max bend each way, degrees (default 60) */
  limit?: number;
}
/** a named point on a bone that other layers can be parented to (they then follow the bone) */
export interface PuppetAttach {
  name: string;
  /** canvas px, TOP-LEFT origin, y down */
  x: number; y: number;
  /** the bone it rides on (default: the nearest one) */
  bone?: string;
  /** layers to parent to this point; they stay where they are now and follow the bone from then on */
  layers?: (string | number)[];
}
export interface PuppetArgs {
  layer: string | number;
  bones: PuppetBoneArg[];
  /** grid cells along the longer side of the picture (default 40, 8..200) */
  detail?: number;
  /** prefix of the user property keys / label (default: the layer name) */
  name?: string;
  sway?: number; lean?: number;
  /** seconds of one idle cycle (default 6) */
  period?: number;
  /** seconds each bone along a chain trails its parent in the sway (default 0.35) */
  lag?: number;
  /** shared "Animate everything" switch + "Animation speed" slider (default true) */
  master?: boolean;
  /** true or settings: bone physics on every bone that has a parent (the root keeps the script motion and drives the others) */
  physics?: boolean | PuppetPhysics;
  attach?: PuppetAttach[];
}

/** Grid cells that hold an opaque pixel, plus one cell around them (so soft edges and motion never meet the mesh border). */
function gridMesh(tex: { w: number; h: number; rgba: Buffer }, nat: number[], detail: number) {
  const [W, H] = nat, cell = Math.max(W, H) / detail;
  const cols = Math.max(1, Math.ceil(W / cell)), rows = Math.max(1, Math.ceil(H / cell));
  const solid = new Uint8Array(cols * rows);
  for (let y = 0; y < tex.h; y++) {
    const j = Math.min(rows - 1, Math.floor((y * rows) / tex.h));
    for (let x = 0; x < tex.w; x++) if (tex.rgba[(y * tex.w + x) * 4 + 3] > 8) solid[j * cols + Math.min(cols - 1, Math.floor((x * cols) / tex.w))] = 1;
  }
  const near = (i: number, j: number) => { for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (i + di >= 0 && i + di < cols && j + dj >= 0 && j + dj < rows && solid[(j + dj) * cols + i + di]) return true; return false; };
  const vid = new Int32Array((cols + 1) * (rows + 1)).fill(-1), pts: { x: number; y: number; u: number; v: number }[] = [], tris: number[] = [];
  const at = (i: number, j: number) => {
    const k = j * (cols + 1) + i;
    if (vid[k] < 0) { vid[k] = pts.length; pts.push({ x: -W / 2 + (W * i) / cols, y: H / 2 - (H * j) / rows, u: i / cols, v: j / rows }); }
    return vid[k];
  };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (near(i, j)) { const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1); tris.push(a, c, b, b, c, d); }
  return { pts, tris };
}

const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

export async function addPuppet(project: string, a: PuppetArgs): Promise<string> {
  const ctx = openScene(project), { scene, dir } = ctx;
  const layer = findLayer(scene, a.layer);
  if (kindOf(layer) !== "image" || utilKind(layer) || typeof layer.image !== "string") throw new Error(`"${layer.name}" is not a picture layer.`);
  const al = layer.alpha;
  if (al && typeof al === "object" && "user" in al) throw new Error("The alpha of this layer is bound to a user property; the bone script needs it. Unbind alpha first.");
  if (!a.bones?.length) throw new Error("bones needs at least one bone ({name, x, y, parent?}).");
  const idx = new Map<string, number>();
  a.bones.forEach((b, i) => {
    if (!b.name || idx.has(b.name)) throw new Error(`Bone ${i}: name missing or used twice ("${b.name}").`);
    if (![b.x, b.y].every(Number.isFinite)) throw new Error(`Bone "${b.name}": x and y are canvas px.`);
    if (b.parent !== undefined && !idx.has(b.parent)) throw new Error(`Bone "${b.name}": parent "${b.parent}" must be listed BEFORE it.`);
    idx.set(b.name, i);
  });

  /* ---- model + texture ---- */
  const img: string = layer.image, ours = /_mcp\.json$/.test(img);
  const model = img.startsWith("models/") ? readJson(path.join(dir, img)) ?? readJson(path.join(ASSETS, img)) : { autosize: true, material: img };
  if (!model?.material) throw new Error(`Cannot read the model of "${layer.name}" (${img}).`);
  if (model.puppet && !ours) throw new Error(`"${layer.name}" is already a puppet made in the editor; edit it there.`);
  const tex = await layerTexture(dir, layer);
  if (!tex) throw new Error(`"${layer.name}" has no readable texture.`);
  const nat = parseVec(layer.size, [tex.w, tex.h]);

  /* ---- bones: canvas px -> layer space (centred, y up, unscaled) ---- */
  const cv = sceneSize(scene), W = worldXf(scene, layer), r = (W.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const toLayer = (px: number, py: number) => { const dx = px - W.x, dy = cv.h - py - W.y; return [(c * dx + s * dy) / (W.sx || 1), (-s * dx + c * dy) / (W.sy || 1)]; };
  const P = a.bones.map(b => toLayer(b.x, b.y));
  const par = a.bones.map(b => (b.parent === undefined ? -1 : idx.get(b.parent)!));
  const child = par.map((_, i) => par.findIndex(p => p === i));
  const tip = P.map((p, i) => (child[i] >= 0 ? P[child[i]] : par[i] >= 0 ? [2 * p[0] - P[par[i]][0], 2 * p[1] - P[par[i]][1]] : p));

  /* ---- bone physics: the constraint JSON the editor writes (Bone Constraints), keys read from a real physics chain ---- */
  const ph: PuppetPhysics = typeof a.physics === "object" ? a.physics : {}, physBone = (i: number) => a.bones[i].physics ?? (!!a.physics && par[i] >= 0);
  const boneJson = (i: number): string => {
    if (!physBone(i)) return "";
    const dx = tip[i][0] - P[i][0], dy = tip[i][1] - P[i][1], l = Math.hypot(dx, dy), v = (x: number, y: number) => `${x.toFixed(5)} ${y.toFixed(5)} 0.00000`;
    const lim = ((ph.limit ?? 60) * Math.PI) / 180, spring = (ph.mode ?? "spring") === "spring";
    return JSON.stringify({
      a: l && child[i] < 0 ? v(dx / l, dy / l) : "1 0 0",   // tip forward: toward the child by itself; the last bone must be turned to point along its parent
      gd: "0 -1 0", ge: !!ph.gravity, ik: false, ikce: false, ikcp: false, ikcpn: 1, ikd: 2, ikg: true, ikr: true, ikrd: 25, ikrmax: 3.1415927, ikrmin: 0, ikse: true,
      la: true, lamax: `0.00000 0.00000 ${lim.toFixed(5)}`, lamin: `0.00000 0.00000 ${(-lim).toFixed(5)}`, lt: false, ltmax: 100,
      m: ph.mass ?? 20, r: true, rax: false, ray: false, raz: true, re: !spring, rf: ph.friction ?? 12, ri: ph.inertia ?? 30, rs: ph.stiffness ?? 300, s: 0, se: spring,
      t: false, tax: true, tay: true, taz: true, tf: 20, ti: 30, tm: 200, tp: l ? v(dx, dy) : "100.00000 0.00000 0.00000", ts: 200,
    });
  };
  const bones: MdlBone[] = a.bones.map((b, i) => ({ name: b.name, parent: par[i], x: P[i][0] - (par[i] >= 0 ? P[par[i]][0] : 0), y: P[i][1] - (par[i] >= 0 ? P[par[i]][1] : 0), json: boneJson(i) }));

  /* ---- attachment points (MDAT) + the layers that ride on them ---- */
  const attNames = new Set<string>();
  const points = (a.attach ?? []).map(t => {
    if (!t.name || attNames.has(t.name)) throw new Error(`Attachment name missing or used twice ("${t.name}").`);
    attNames.add(t.name);
    if (![t.x, t.y].every(Number.isFinite)) throw new Error(`Attachment "${t.name}": x and y are canvas px.`);
    const q = toLayer(t.x, t.y);
    const bone = t.bone !== undefined ? idx.get(t.bone) : P.map((_, i) => ({ i, d: segDist(q[0], q[1], P[i][0], P[i][1], tip[i][0], tip[i][1]) })).sort((m, n) => m.d - n.d)[0].i;
    if (bone === undefined) throw new Error(`Attachment "${t.name}": no bone called "${t.bone}".`);
    const riders = (t.layers ?? []).map(ref => {
      const o = findLayer(scene, ref);
      for (let p: any = layer; p; p = p.parent === undefined ? undefined : scene.objects.find((n: any) => n.id === p.parent)) if (p === o) throw new Error(`Attachment "${t.name}": "${o.name}" is the puppet itself or one of its parents.`);
      return o;
    });
    return { t, riders, mdl: { name: t.name, bone, x: q[0] - P[bone][0], y: q[1] - P[bone][1] } as MdlAttach };
  });

  /* ---- mesh + skin weights ---- */
  const { pts, tris } = gridMesh(tex, nat, Math.max(8, Math.min(200, Math.round(a.detail ?? 40))));
  if (!pts.length) throw new Error(`"${layer.name}" is fully transparent: nothing to deform.`);
  const verts: MdlVertex[] = pts.map(v => {
    const near = P.map((_, i) => ({ i, w: 1 / (segDist(v.x, v.y, P[i][0], P[i][1], tip[i][0], tip[i][1]) ** 2 + 1) })).sort((p, q) => q.w - p.w).slice(0, 2);
    const sum = near.reduce((n, k) => n + k.w, 0);
    return { ...v, bones: [near[0].i, near[1]?.i ?? 0], weights: [near[0].w / sum, near[1] ? near[1].w / sum : 0] };
  });

  /* ---- files + layer ---- */
  const base = path.basename(img, ".json").replace(/_mcp$/, ""), mdlRel = `models/${base}_mcp_puppet.mdl`;
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, mdlRel), writeMdl(model.material, verts, tris, bones, points.map(p => p.mdl)));
  fs.writeFileSync(path.join(dir, `models/${base}_mcp.json`), JSON.stringify({ ...model, puppet: mdlRel }, null, "\t"));
  layer.image = `models/${base}_mcp.json`;
  for (const { t, riders } of points) for (const o of riders) {   // the rider keeps its world place: its local origin is measured from the attachment point
    const at = { origin: vecStr([t.x, cv.h - t.y, 0]), scale: vecStr([W.sx, W.sy, 1]), angles: anglesStr(W.rot) };
    setLocal(o, localFromWorld(scene, at, worldXf(scene, o)));
    o.parent = layer.id; o.attachment = t.name;
  }
  saveScene(ctx);

  /* ---- motion: one script, switches and sliders ---- */
  const label = a.name ?? layer.name ?? "Puppet", p = slug(label), key = (k: string) => `${p}_${k}`, master = a.master !== false;
  const period = a.period ?? 6, lagRad = ((a.lag ?? 0.35) * 2 * Math.PI) / period;
  const depth = (i: number): number => (par[i] < 0 ? 0 : 1 + depth(par[i]));
  const rows = a.bones.map((b, i) => {
    const dy = tip[i][1] - P[i][1], len = Math.hypot(tip[i][0] - P[i][0], dy);
    const dirSign = len === 0 ? -1 : Math.abs(dy) < 0.25 * len ? 0 : dy > 0 ? -1 : 1;   // toward the cursor: an upright bone leans clockwise, a hanging one counter-clockwise
    const f = (n: number) => +((n * Math.PI) / 180).toFixed(5);
    return [i, f(b.sway ?? (physBone(i) ? 0 : a.sway ?? 3)), f((b.lean ?? a.lean ?? 0) * dirSign), depth(i)];
  }).filter(r => r[1] || r[2]);
  const useSway = rows.some(r => r[1]), useLean = rows.some(r => r[2]);
  const wantLean = a.lean || a.bones.some(b => b.lean);
  if (!rows.length) return `Puppet "${label}": ${bones.length} bone(s), ${pts.length} vertices, ${tris.length / 3} triangles written; sway and lean are both 0 so no script was added (drive the bones with add_script code and thisLayer.setLocalBoneAngles).`;
  const slider = (name: string, label: string): SProp => ({ name, label, kind: "slider", value: 1, min: 0, max: 2.5 });
  const props: SProp[] = [
    { name: "master", label: "Master switch", kind: "checkbox", value: true }, { name: "speed", label: "Speed", kind: "slider", value: 1, min: 0, max: 3 },
    ...(useSway ? [{ name: "swayOn", label: "Sway", kind: "checkbox", value: true } as SProp, slider("swayAmt", "Sway amount")] : []),
    ...(useLean ? [{ name: "leanOn", label: "Lean", kind: "checkbox", value: true } as SProp, slider("leanAmt", "Lean amount")] : []),
  ];
  const code = `${header(props)}
const BONES = ${JSON.stringify(rows)}, PERIOD = ${period}, LAG = ${+lagRad.toFixed(4)}, SEED = 1.7, SMOOTH = 3;
var phase = 0, sw = -1, ln = -1, cx = 0;
function wave(p, s) { return 0.55 * Math.sin(p + s) + 0.30 * Math.sin(p * 1.73 + s * 2.3) + 0.15 * Math.sin(p * 2.91 + s * 4.1); }
export function update(value) {
	var dt = Math.min(engine.frametime, 0.1), m = scriptProperties.master ? 1 : 0, e = Math.min(1, dt * 3);
	var ts = m * (scriptProperties.swayOn ? scriptProperties.swayAmt : 0), tl = m * (scriptProperties.leanOn ? scriptProperties.leanAmt : 0);
	sw = sw < 0 ? ts : sw + (ts - sw) * e; ln = ln < 0 ? tl : ln + (tl - ln) * e;
	phase += dt * scriptProperties.speed * 6.2831853 / PERIOD;
	var cs = engine.canvasSize, cur = input.cursorWorldPosition;
	cx += (Math.max(-1, Math.min(1, (cur.x / cs.x - 0.5) * 2)) - cx) * (1 - Math.exp(-dt * SMOOTH));
	for (var n = 0; n < BONES.length; n++) {
		var b = BONES[n];
		thisLayer.setLocalBoneAngles(b[0], new Vec3(0, 0, b[1] * sw * wave(phase - b[3] * LAG, SEED) + b[2] * ln * cx));
	}
	return value;
}
`;
  updateProperties(project, undefined, undefined, undefined, undefined, [
    ...(master ? [{ property: "anim_master", type: "bool" as const, label: "Animate everything", value: true }, { property: "anim_speed", type: "slider" as const, label: "Animation speed", value: 1, min: 0.2, max: 2.5, step: 0.05, show_if: "anim_master" }] : []),
    { property: `g_${p}`, type: "group" as const, label },
  ]);
  const opt = (k: string, text: string) => ({
    [`${k}On`]: { property: key(k), label: text, ...(master ? { show_if: "anim_master" } : {}) },
    [`${k}Amt`]: { property: key(k) + "_amt", label: `${text} amount`, min: 0, max: 2.5, step: 0.05, show_if: key(k) },
  });
  const bind = { ...(master ? { master: { property: "anim_master" }, speed: { property: "anim_speed" } } : {}), ...(useSway ? opt("sway", `${label} sway`) : {}), ...(useLean ? opt("lean", `${label} leans toward the mouse`) : {}) };
  addScript(project, layer.id, { property: "alpha", code, props, bind });

  return [
    `Puppet "${label}" on [${layer.id}] "${layer.name}": ${bones.length} bone(s), ${pts.length} vertices, ${tris.length / 3} triangles (grid ${Math.round(Math.max(...nat) / Math.max(8, Math.min(200, Math.round(a.detail ?? 40))))} px).`,
    `Files: ${mdlRel}, models/${base}_mcp.json (the layer now uses it). Bones: ${a.bones.map((b, i) => `${i}:${b.name}${par[i] >= 0 ? `<-${a.bones[par[i]].name}` : ""}`).join(", ")}.`,
    `Script on the layer's alpha: ${[useSway && `sway (${key("sway")}, ${key("sway")}_amt)`, useLean && `lean (${key("lean")}, ${key("lean")}_amt)`].filter(Boolean).join(", ")}${master ? "; shared anim_master and anim_speed" : ""}.`,
    ...(bones.some(b => b.json) ? [`Bone physics (${(ph.mode ?? "spring")}) on: ${a.bones.filter((_, i) => physBone(i)).map(b => b.name).join(", ")}. It reacts to the movement of the parent bone, so keep sway on the root; there is no switch for it.`] : []),
    ...(points.length ? [`Attachments: ${points.map(p => `"${p.t.name}" on ${a.bones[p.mdl.bone].name}${p.riders.length ? ` (carries ${p.riders.map(o => `"${o.name}"`).join(", ")})` : ""}`).join("; ")}. To put more layers on a point run add_puppet again with them in attach[].layers.`] : []),
    ...(wantLean && !useLean ? ["Lean ignored: it needs bones that point up or down (a horizontal bone has no side to lean to); drive those with sway."] : []),
    "Judge with capture_wallpaper (frames:4; cursor:{x,y} + click:true for the lean: the window must be in front to see the mouse; open each check in a NEW window name, bones keep their last pose otherwise). Run add_puppet again with other bones to redo it.",
  ].join("\n");
}
