import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { encodeTex, loadRgba, texToRgba } from "../tex";
import { colorStr, findLayer, openScene, saveScene } from "../sceneio";
import { materialOf } from "./light";

/* ====================================================================
   Material of an image layer (genericimage4, read off WE's own shader): normal map, PBR masks, reflection.
   textures: [albedo, normal map (NORMALMAP, 2 channels RG), PBR masks (PBRMASKS: R metallic, G roughness, B reflection, A emissive)]
   combos:   LIGHTING / REFLECTION (reflection also needs NORMALMAP) + METALLIC_MAP / ROUGHNESS_MAP / REFLECTION_MAP / EMISSIVE_MAP
   constants (pass.constantshadervalues): roughness, metallic, speculartint, emissivecolor, emissivebrightness, reflectivity, reflectivitydistance.
   ==================================================================== */

/**
 * Tangent-space normal map (RGBA, x/y in red/green, 128 = flat) of a height field: the surface slopes DOWN away from the bright parts.
 * `strength` scales the slope (1 = gentle, 4+ = deep relief); `flipY` swaps the green axis (DirectX / OpenGL convention).
 */
export function heightToNormal(height: ArrayLike<number>, w: number, h: number, strength: number, flipY = false): Buffer {
  const out = Buffer.alloc(w * h * 4);
  const at = (x: number, y: number) => height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength, dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength * (flipY ? -1 : 1);
    const len = Math.hypot(dx, dy, 1), o = (y * w + x) * 4;
    out[o] = Math.round((-dx / len * 0.5 + 0.5) * 255);
    out[o + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);   // image y grows downwards: a slope rising downwards tilts the normal towards +y
    out[o + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
    out[o + 3] = 255;
  }
  return out;
}

/** Gaussian blur of a 1-channel height field (sharp returns 3 channels after blur: keep one, or every later index is wrong). */
export const smoothHeight = (grey: Buffer, w: number, h: number, sigma: number): Promise<Buffer> =>
  sharp(grey, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();

export interface MaterialArgs {
  /** "auto" = relief from the picture itself (brightness x opacity: bright = raised) or an absolute path of a normal map image */
  normal_map?: string;
  /** auto relief depth (default 3); blur px smooths it first (default 1.5, 0 = sharp) */
  normal_strength?: number; normal_blur?: number;
  /** flip the green axis of the normal map (if lights seem to come from the wrong side vertically) */
  flip_y?: boolean;
  /** grayscale images (absolute paths, same aspect as the layer) packed into the PBR mask texture */
  metallic_map?: string; roughness_map?: string; reflection_map?: string; emissive_map?: string;
  roughness?: number; metallic?: number; specular_tint?: string;
  emissive?: { color?: string; brightness?: number };
  /** reflect what is drawn BELOW this layer (water, glass, polished floor), bent by the normal map */
  reflection?: boolean; reflectivity?: number; reflectivity_distance?: number;
  /** remove the normal map, the masks and the reflection again */
  clear?: boolean;
}

const MAPS = ["metallic_map", "roughness_map", "reflection_map", "emissive_map"] as const;
const COMBO: Record<(typeof MAPS)[number], string> = { metallic_map: "METALLIC_MAP", roughness_map: "ROUGHNESS_MAP", reflection_map: "REFLECTION_MAP", emissive_map: "EMISSIVE_MAP" };

async function writeAux(dir: string, name: string, rgba: Buffer, w: number, h: number, format: "rg88" | "rgba") {
  const mats = path.join(dir, "materials");
  fs.writeFileSync(path.join(mats, name + ".tex"), await encodeTex(rgba, w, h, { format, bleed: false }));
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path.join(mats, name + ".png"));
  fs.writeFileSync(path.join(mats, name + ".tex-json"), JSON.stringify({ clampuvs: true, format: format === "rg88" ? "rg88" : "rgba8888", nonpoweroftwo: true }, null, "\t"));
}

export async function setMaterial(project: string, layerRef: string | number, a: MaterialArgs): Promise<string> {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  const obj = findLayer(scene, layerRef);
  const m = materialOf(dir, obj);
  if (!m) throw new Error(`"${obj.name}" has no editable material: only plain image layers (not sprite sheets, solids or effect layers).`);
  const { pass } = m;
  const base: string = pass.textures[0];
  const notes: string[] = [];
  pass.combos = pass.combos ?? {};
  pass.constantshadervalues = pass.constantshadervalues ?? {};
  pass.textures = [base, pass.textures[1] ?? null, pass.textures[2] ?? null];

  if (a.clear) {
    for (const k of ["NORMALMAP", "PBRMASKS", "REFLECTION", ...Object.values(COMBO)]) delete pass.combos[k];
    pass.textures = [base];
    for (const k of ["roughness", "metallic", "speculartint", "emissivecolor", "emissivebrightness", "reflectivity", "reflectivitydistance"]) delete pass.constantshadervalues[k];
    notes.push("normal map, masks and reflection removed");
  }

  // size of the albedo (every map must line up with it)
  let size: { w: number; h: number } | undefined;
  const albedoTex = path.join(dir, "materials", base + ".tex");
  const albedo = () => (size ? Promise.resolve(size) : texToRgba(fs.readFileSync(albedoTex)).then(t => (size = { w: t.w, h: t.h })));

  if (a.normal_map) {
    const { w, h } = await albedo().catch(() => { throw new Error(`Cannot read the picture of "${obj.name}" (video layers: pass a normal map image path instead of "auto").`); });
    let rgba: Buffer;
    if (a.normal_map === "auto") {
      const tex = await texToRgba(fs.readFileSync(albedoTex));
      const grey = Buffer.alloc(w * h);
      for (let i = 0; i < w * h; i++) grey[i] = ((tex.rgba[i * 4] * 0.299 + tex.rgba[i * 4 + 1] * 0.587 + tex.rgba[i * 4 + 2] * 0.114) * tex.rgba[i * 4 + 3]) / 255;
      const blur = a.normal_blur ?? 1.5;
      const hf = blur > 0 ? await smoothHeight(grey, w, h, blur) : grey;
      rgba = heightToNormal(hf, w, h, a.normal_strength ?? 3, a.flip_y);
      notes.push(`normal map generated from the picture (strength ${a.normal_strength ?? 3}, blur ${blur})`);
    } else {
      if (!path.isAbsolute(a.normal_map) || !fs.existsSync(a.normal_map)) throw new Error(`Normal map not found: "${a.normal_map}" (use "auto" or an absolute path).`);
      rgba = (await loadRgba(a.normal_map, { w, h })).rgba;
      if (a.flip_y) for (let i = 1; i < rgba.length; i += 4) rgba[i] = 255 - rgba[i];
      notes.push("normal map from your image (red = x, green = y)");
    }
    await writeAux(dir, base + "_normal", rgba, w, h, "rg88");
    pass.textures[1] = base + "_normal";
    pass.combos.NORMALMAP = 1;
  }

  // PBR masks: pack the given grayscale images into R / G / B / A
  const given = MAPS.filter(k => a[k]);
  if (given.length) {
    const { w, h } = await albedo().catch(() => { throw new Error(`Cannot read the picture of "${obj.name}".`); });
    const old = pass.textures[2] && fs.existsSync(path.join(dir, "materials", pass.textures[2] + ".tex")) ? await texToRgba(fs.readFileSync(path.join(dir, "materials", pass.textures[2] + ".tex"))) : undefined;
    const px = old && old.w === w && old.h === h ? Buffer.from(old.rgba) : Buffer.alloc(w * h * 4);
    for (const k of given) {
      const f = a[k]!;
      if (!path.isAbsolute(f) || !fs.existsSync(f)) throw new Error(`${k} not found: "${f}" (use an absolute path).`);
      const g = await sharp(f, { failOn: "none" }).resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer();
      const c = MAPS.indexOf(k);
      for (let i = 0; i < w * h; i++) px[i * 4 + c] = g[i];
      pass.combos[COMBO[k]] = 1;
    }
    await writeAux(dir, base + "_masks", px, w, h, "rgba");
    pass.textures[2] = base + "_masks";
    pass.combos.PBRMASKS = 1;
    notes.push(`mask channels: ${given.map(k => k.replace("_map", "")).join(", ")}`);
  }

  const cv = pass.constantshadervalues;
  if (a.roughness !== undefined) cv.roughness = a.roughness;
  if (a.metallic !== undefined) cv.metallic = a.metallic;
  if (a.specular_tint !== undefined) cv.speculartint = colorStr(a.specular_tint);
  if (a.emissive?.color !== undefined) cv.emissivecolor = colorStr(a.emissive.color);
  if (a.emissive?.brightness !== undefined) cv.emissivebrightness = a.emissive.brightness;
  if (a.reflectivity !== undefined) cv.reflectivity = a.reflectivity;
  if (a.reflectivity_distance !== undefined) cv.reflectivitydistance = a.reflectivity_distance;
  if (a.reflection !== undefined) {
    if (a.reflection && !pass.combos.NORMALMAP) throw new Error('reflection needs a normal map: pass normal_map ("auto" or an image).');
    if (a.reflection) pass.combos.REFLECTION = 1; else delete pass.combos.REFLECTION;
    notes.push(a.reflection ? "reflection on (it mirrors what is below this layer, bent by the normal map)" : "reflection off");
  }
  if (!pass.textures[2]) pass.textures.length = pass.textures[1] ? 2 : 1;
  m.save();
  saveScene(ctx);
  const lit = Number(pass.combos.LIGHTING ?? 0);
  return [
    `Material of [${obj.id}] "${obj.name}": ${notes.join("; ") || "constants updated"}.`,
    lit ? "" : "The layer does not receive light yet: the normal map / roughness / metallic only show with lighting (add_light lit:[...] or update_layer lighting:true); reflection works without lights.",
    "Not drawn by preview_scene: judge it with capture_wallpaper.",
  ].filter(Boolean).join("\n");
}
