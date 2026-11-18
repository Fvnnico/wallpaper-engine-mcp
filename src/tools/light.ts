import * as fs from "fs";
import * as path from "path";
import { Obj, openScene, saveScene, nextId, sceneSize, findLayer, vecStr, colorStr, bindable, insertAt, kindOf, utilKind, parseVec, Place } from "../sceneio";
import { readJson } from "../render";

/* ====================================================================
   Lights. Format read off the installed Workshop scenes and calibrated in the engine (WE 2.8):
   {light: "lpoint" | "lspot" | "ltube" | "ldirectional", origin: "x y z" (z = height above the wallpaper), color, intensity, radius (px),
    angles (rad), innercone / outercone (degrees, spot), controlpoint (tube: offset from origin to the other end)}.
   A spot / directional light shines along its local +x; angles "0 y z" = yaw z (CCW, in the picture plane) after pitch y (90deg = straight down at the wallpaper).
   An image layer only receives light when its material has the LIGHTING combo; scene.json "general.lightconfig" counts the lights per type (saveScene keeps it right).
   ==================================================================== */

/** First pass of an image layer's material (materials are per texture, so every layer using that texture shares it) + save() to write it back. Only plain genericimage4 layers (not sprite sheets, solids, effect layers). */
export function materialOf(dir: string, obj: Obj): { pass: any; save: () => void } | undefined {
  if (kindOf(obj) !== "image" || utilKind(obj) || typeof obj.image !== "string") return undefined;
  const model = readJson(path.join(dir, obj.image));
  const file = typeof model?.material === "string" ? path.join(dir, model.material) : "";
  const mat = file && fs.existsSync(file) ? readJson(file) : undefined;
  const pass = mat?.passes?.[0];
  return pass?.shader === "genericimage4" ? { pass, save: () => fs.writeFileSync(file, JSON.stringify(mat, null, "\t")) } : undefined;
}

/** Turn the LIGHTING combo of an image layer's material on or off. */
export function setLighting(dir: string, obj: Obj, on: boolean): "changed" | "same" | "unsupported" {
  const m = materialOf(dir, obj);
  if (!m) return "unsupported";
  if (Number(m.pass.combos?.LIGHTING ?? 0) === (on ? 1 : 0)) return "same";
  m.pass.combos = { ...(m.pass.combos ?? {}), LIGHTING: on ? 1 : 0 };
  m.save();
  return "changed";
}

type LightType = "point" | "spot" | "tube" | "directional";
const DEFAULTS: Record<LightType, { intensity: number; radius: number; height: number }> = {
  point: { intensity: 5, radius: 600, height: 100 },
  spot: { intensity: 8, radius: 1000, height: 300 },
  tube: { intensity: 5, radius: 150, height: 60 },
  directional: { intensity: 2, radius: 50, height: 300 },
};

export interface LightArgs {
  type?: LightType; name?: string;
  /** canvas px, TOP-LEFT origin (default: canvas centre) */
  x?: number; y?: number;
  /** height above the wallpaper (the z of the origin) */
  height?: number;
  color?: any; intensity?: any; radius?: any;
  /** spot / directional: the point of the canvas the light shines at (default: straight down below it) */
  aim?: { x: number; y: number };
  /** spot cone in degrees */
  cone?: { inner?: number; outer?: number };
  /** tube: the other end, canvas px */
  to?: { x: number; y: number };
  /** which image layers receive the light: "all" (default), "none" or a list. They get the LIGHTING combo on their material */
  lit?: "all" | "none" | (string | number)[];
  /** scene ambient light (what lit layers get where no light reaches): a number 0..1 or a colour */
  ambient?: number | string;
  visible?: any; position?: Place;
  /** visible light beam / fog in the air (god rays); density and exponent shape it */
  volumetrics?: boolean | { density?: number; exponent?: number };
}

export function addLight(project: string, a: LightArgs): string {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  const cv = sceneSize(scene);
  const type = a.type ?? "point", d = DEFAULTS[type];
  const x = a.x ?? cv.w / 2, y = a.y ?? cv.h / 2, h = a.height ?? d.height;
  if (!(h > 0)) throw new Error("height must be > 0 (the light floats above the wallpaper).");
  const o: Obj = {
    angles: "0.00000 0.00000 0.00000", castshadow: false, color: a.color && typeof a.color === "object" && !Array.isArray(a.color) ? bindable(dir, a.color, "1 1 1") : colorStr(a.color ?? "#ffffff"), density: 2, exponent: 1.83, id: nextId(scene),
    intensity: bindable(dir, a.intensity ?? d.intensity, d.intensity), light: "l" + type, name: a.name ?? `${type} light`,
    origin: vecStr([x, cv.h - y, h]), parallaxDepth: "0.00000 0.00000", radius: bindable(dir, a.radius ?? d.radius, d.radius), visible: true, volumetricsexponent: 1,
  };
  if (a.visible !== undefined && a.visible !== true) o.visible = bindable(dir, a.visible, true);
  const notes: string[] = [];
  if (type === "spot" || type === "directional") {
    const t = a.aim ?? { x, y };
    // direction from the light to the target on the wallpaper plane (scene y is up); forward = (cos p cos yaw, cos p sin yaw, -sin p)
    const dx = t.x - x, dy = y - t.y, len = Math.hypot(dx, dy, h);
    o.angles = vecStr([0, Math.asin(h / len), Math.atan2(dy, dx)]);
    notes.push(a.aim ? `shines at (${t.x}, ${t.y}) px` : "shines straight down");
  }
  if (type === "spot") { o.innercone = a.cone?.inner ?? 25; o.outercone = a.cone?.outer ?? 45; }
  // castvolumetrics + density + volumetricsexponent: verified live (a visible beam). Not offered because they showed no effect in WE 2.8 on a flat scene:
  // castshadow (light + layers) and usecookie / cookie ("cookie/flashlight1").
  if (a.volumetrics) {
    o.castvolumetrics = true;
    if (typeof a.volumetrics === "object") { if (a.volumetrics.density !== undefined) o.density = a.volumetrics.density; if (a.volumetrics.exponent !== undefined) o.volumetricsexponent = a.volumetrics.exponent; }
    notes.push("volumetric beam");
  }
  if (type === "tube") {
    const e = a.to ?? { x: x + 400, y };
    o.controlpoint = vecStr([e.x - x, y - e.y, 0]);
    notes.push(`from (${x}, ${y}) to (${e.x}, ${e.y}) px`);
  }
  insertAt(scene, o, a.position ?? "top");

  // receivers
  const imageLayers = scene.objects.filter((l: Obj) => kindOf(l) === "image" && !utilKind(l));
  const targets: Obj[] = a.lit === "none" ? [] : Array.isArray(a.lit) ? a.lit.map(r => findLayer(scene, r)) : imageLayers;
  const res = { changed: 0, same: 0, unsupported: [] as string[] };
  for (const l of targets) { const r = setLighting(dir, l, true); if (r === "unsupported") res.unsupported.push(String(l.name)); else res[r]++; }
  if (a.ambient !== undefined) scene.general.ambientcolor = typeof a.ambient === "number" ? vecStr([a.ambient, a.ambient, a.ambient]) : colorStr(a.ambient);
  saveScene(ctx);

  const amb = parseVec(scene.general?.ambientcolor, [0.3, 0.3, 0.3])[0];
  return [
    `Added ${type} light [${o.id}] "${o.name}" at (${x}, ${y}) px, ${h} px above the wallpaper${notes.length ? ", " + notes.join(", ") : ""}; intensity ${typeof o.intensity === "object" ? "bound" : o.intensity}, radius ${typeof o.radius === "object" ? "bound" : o.radius} px.`,
    targets.length ? `Lighting on for ${res.changed + res.same} image layer(s)${res.unsupported.length ? `; not lightable (sprite sheets / effect layers): ${res.unsupported.join(", ")}` : ""}.` : "No layer receives light yet: pass lit or use update_layer {lighting:true}.",
    `A lit layer is shaded by the scene ambient light (${amb.toFixed(2)}) where no light reaches it${amb < 0.5 ? ": the picture looks darker than before - raise it with ambient (e.g. 0.6) or scene_settings if that is not wanted" : ""}.`,
    "Not drawn by preview_scene: judge it with capture_wallpaper. Animate it with add_script property \"intensity\" (templates gain / audio).",
  ].join("\n");
}
