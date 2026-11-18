import { findLayer, openScene, sceneSize, slug } from "../sceneio";
import { updateProperties } from "./properties";
import { addGroup, updateLayer } from "./scene";
import { addScript } from "./script";

/*
 * A figure as a chain of pivot groups with continuous scripts, tuned on a 1440 px canvas:
 *   body : lean (mouse) > sway (idle, publishes its angle) > breath (scale)      -> the body layers are children of the last one
 *   head : head (lags behind the sway) > head look (idle + mouse) > head aim (mouse) -> the head layers are children of the last one,
 *          the whole head chain hangs under the body chain so the head follows the body
 * Every movement gets a switch + an amount slider in the properties panel, plus a shared master switch and speed slider.
 */

export interface RigArgs {
  /** layers that move with the whole figure */
  body: (string | number)[];
  /** pivot of the body chain, canvas px (default: bottom-centre of the canvas: the figure leans about its feet) */
  body_pivot?: { x: number; y: number };
  /** layers of the head (usually a copy of the figure clipped to the head); needs head_pivot */
  head?: (string | number)[];
  /** the neck, canvas px */
  head_pivot?: { x: number; y: number };
  /** default all: lean = follows the mouse, sway = idle sway, breath = breathing, head = idle head tilt and nod */
  motions?: ("lean" | "sway" | "breath" | "head")[];
  /** prefix of the groups ("<name> lean", ...) and of the user property keys (default "rig") */
  name?: string;
  /** shared "Animate everything" switch and "Animation speed" slider (default true) */
  master?: boolean;
}

const BODY = ["lean", "sway", "breath"] as const, HEAD = ["head", "head look", "head aim"] as const;

export function addMotionRig(project: string, a: RigArgs): string {
  const { scene } = openScene(project);
  const cv = sceneSize(scene), name = a.name ?? "rig", p = slug(name), motions = new Set(a.motions ?? ["lean", "sway", "breath", "head"]);
  const s = cv.h / 1440;   // amplitudes in px were tuned on a 1440 px high canvas
  if (!a.body?.length) throw new Error("body needs at least one layer.");
  if (a.head?.length && !a.head_pivot) throw new Error("head needs head_pivot ({x, y} = the neck in canvas px).");
  const useHead = !!a.head?.length && (motions.has("head") || motions.has("lean"));
  // fail before touching anything: a typo in a layer name must not leave half a rig behind
  for (const r of [...a.body, ...(a.head ?? [])]) findLayer(scene, r);
  const g = (n: string) => `${name} ${n}`;
  if (scene.objects.some((o: any) => [...BODY, ...HEAD].some(n => o.name === g(n)))) throw new Error(`A rig named "${name}" already exists in this scene; pass another name.`);

  const lines: string[] = [];
  /* ---- groups ---- */
  let bodyEnd: string | undefined, headEnd: string | undefined;
  const chain = (names: readonly string[], at: { x: number; y: number }, parent: string | undefined) => {
    for (const n of names) { addGroup(project, { name: g(n), x: at.x, y: at.y, parent }); parent = g(n); lines.push(`group "${g(n)}" pivot (${at.x}, ${at.y})`); }
    return parent;
  };
  bodyEnd = chain(BODY.filter(n => motions.has(n)), a.body_pivot ?? { x: cv.w / 2, y: cv.h }, undefined);
  if (useHead) headEnd = chain(HEAD, a.head_pivot!, bodyEnd);
  for (const l of a.body) if (bodyEnd) updateLayer(project, l, { parent: bodyEnd });
  for (const l of a.head ?? []) if (useHead ? headEnd : bodyEnd) updateLayer(project, l, { parent: useHead ? headEnd : bodyEnd });

  /* ---- options: shared master + speed first, then this rig's section ---- */
  const master = a.master !== false, key = (k: string) => `${p}_${k}`;
  updateProperties(project, undefined, undefined, undefined, undefined, [
    ...(master ? [{ property: "anim_master", type: "bool" as const, label: "Animate everything", value: true }, { property: "anim_speed", type: "slider" as const, label: "Animation speed", value: 1, min: 0.2, max: 2.5, step: 0.05, show_if: "anim_master" }] : []),
    { property: `g_${p}`, type: "group" as const, label: name },
  ]);
  const used = new Set<string>();
  const bind = (k: string, label: string) => (used.add(key(k)), {
    enabled: { property: key(k), label, ...(master ? { show_if: "anim_master" } : {}) },
    amount: { property: key(k) + "_amt", label: `${label} amount`, min: 0, max: 2.5, step: 0.05, show_if: key(k) },
    ...(master ? { master: { property: "anim_master" }, speed: { property: "anim_speed" } } : {}),
  });
  const run = (layer: string, args: Record<string, any>) => addScript(project, g(layer), args);
  const sway = key("sway");
  if (motions.has("lean") && bodyEnd) {
    const b = bind("look", "Lean toward the mouse");
    run("lean", { property: "origin", template: "cursor", amplitude: [8 * s, 4 * s], bind: b });
    run("lean", { property: "angles", template: "cursor", amplitude: 1.2, invert: true, bind: b });
  }
  if (motions.has("sway")) {
    const b = bind("sway", "Body sway");
    run("sway", { property: "angles", template: "wobble", amplitude: 0.7, period: 7.5, shape: "noise", seed: 1.3, publish: sway, bind: b });
    run("sway", { property: "origin", template: "wobble", amplitude: [2 * s, 1.5 * s], period: 9.1, shape: "noise", seed: 4.2, bind: b });
  }
  if (motions.has("breath")) run("breath", { property: "scale", template: "wobble", amplitude: [0.007, 0.009], period: 4.8, shape: "breath", seed: 0.5, bind: bind("breath", "Breathing") });
  if (useHead && motions.has("head")) {
    const b = bind("head", "Head tilt and nod");
    if (motions.has("sway")) run("head", { property: "angles", template: "lag", from: sway, gain: -0.9, smooth: 4.5, damping: 0.3, bind: b });   // the head follows through behind the body
    run("head", { property: "origin", template: "wobble", amplitude: [1.5 * s, 1.5 * s], period: 6.2, shape: "noise", seed: 2.7, bind: b });
    run("head look", { property: "angles", template: "wobble", amplitude: 1.0, period: 5.6, shape: "noise", seed: 3.9, bind: b });
  }
  if (useHead && motions.has("lean")) {
    const b = bind("look", "Lean toward the mouse");
    run("head look", { property: "origin", template: "cursor", amplitude: [3 * s, 2 * s], bind: b });
    run("head aim", { property: "angles", template: "cursor", amplitude: 1.8, invert: true, bind: b });
  }
  return [
    `Rig "${name}": ${lines.length} groups, ${a.body.length} body layer(s)${a.head?.length ? ` and ${a.head.length} head layer(s)` : ""} attached (world positions unchanged).`,
    ...lines.map(l => "  " + l),
    `Options in the properties panel: ${[...used].join(", ")} (each with a ${p}_<key>_amt slider${master ? "; shared anim_master and anim_speed" : ""}).`,
    "Judge the motion with capture_wallpaper (frames:4; cursor:{x,y} for the lean).",
  ].join("\n");
}
