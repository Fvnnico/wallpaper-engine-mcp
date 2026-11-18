import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { MY_PROJECTS_PATH } from "../config";
import { encodeTex, loadRgba, encodeVideoTex, mp4Size } from "../tex";
import { materialOf, setLighting } from "./light";
import {
  bindProperty, Obj, SceneCtx, openScene, saveScene, nextId, sceneSize, kindOf, findLayer, parseVec, vecStr, slug, colorStr,
  worldXf, originForAnchor, localFromWorld, insertAt, Place, blendMode, bindable, BLEND_MODES, sceneToPx, Xf, anchorPoint, setLocal, anglesStr, isPropSpec, PT_PX,
  UtilKind, UTIL_MODELS, utilKind, FIXED_DEPTH,
} from "../sceneio";

/* ====================================================================
   Texture assets: image -> .tex + material + model (what the editor does on import)
   ==================================================================== */

const MAX_TEX = 8192;

function uniqueBase(dir: string, base: string): string {
  let n = base, i = 2;
  while (["materials/" + n + ".tex", "materials/" + n + ".json", "models/" + n + ".json"].some(f => fs.existsSync(path.join(dir, f)))) n = `${base}_${i++}`;
  return n;
}

export interface TexAsset { base: string; w: number; h: number; model: string }

/** Convert an image file into project assets and return the model path ("models/<base>.json"). */
export async function importTexture(dir: string, imagePath: string, wanted: string, tile = false): Promise<TexAsset> {
  if (!path.isAbsolute(imagePath) || !fs.existsSync(imagePath)) throw new Error(`Image not found: "${imagePath}" (use an absolute path).`);
  const base = uniqueBase(dir, slug(wanted));
  fs.mkdirSync(path.join(dir, "materials"), { recursive: true });
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  const meta = await sharp(imagePath, { failOn: "none" }).metadata();
  let { w, h } = { w: meta.width ?? 0, h: meta.height ?? 0 };
  if (!w || !h) throw new Error(`Cannot read image size of "${imagePath}".`);
  const k = Math.min(1, MAX_TEX / Math.max(w, h));
  const img = await loadRgba(imagePath, k < 1 ? { w: Math.round(w * k), h: Math.round(h * k) } : undefined);
  w = img.w; h = img.h;
  fs.writeFileSync(path.join(dir, "materials", base + ".tex"), await encodeTex(img.rgba, w, h, { tile }));
  const ext = path.extname(imagePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg"].includes(ext) && k === 1) fs.copyFileSync(imagePath, path.join(dir, "materials", base + ext));
  else await sharp(img.rgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path.join(dir, "materials", base + ".png"));
  fs.writeFileSync(path.join(dir, "materials", base + ".tex-json"),
    JSON.stringify({ bleedtransparentcolors: true, clampuvs: !tile, format: "rgba8888", halfmip: true, nonpoweroftwo: true }, null, "\t"));
  fs.writeFileSync(path.join(dir, "materials", base + ".json"), JSON.stringify({
    passes: [{ blending: "translucent", combos: {}, cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled", shader: "genericimage4", textures: [base] }],
  }, null, "\t"));
  fs.writeFileSync(path.join(dir, "models", base + ".json"), JSON.stringify({ autosize: true, material: `materials/${base}.json` }, null, "\t"));
  return { base, w, h, model: `models/${base}.json` };
}

export interface SpriteOpts {
  /** a single image holding the frames: how many across and down (frames in reading order); omit with `frames` */
  cols?: number; rows?: number;
  /** frames used (default all cols x rows) */
  count?: number;
  /** playback speed (default 12) */
  fps?: number;
}

/**
 * Animated texture: one sprite sheet (image + cols x rows) or several same-size images, written the way the editor imports them
 * (frames in reading order in one sheet, flags & 4, a "TEXS" frame table, one mip). WE rebuilds the .tex from the png + .tex-json when it loads
 * a project, so the sheet is exactly cols x rows frames (no padding: WE derives the columns from the png width) and the .tex-json carries the sequence.
 * The layer is as big as ONE frame. ponytail: one frame time for all frames; GIF import is not supported (split it into PNGs first).
 */
export async function importSprite(dir: string, o: { image?: string; frames?: string[]; sprite?: SpriteOpts }, wanted: string): Promise<TexAsset> {
  const sp = o.sprite ?? {}, fps = sp.fps ?? 12;
  if (!(fps > 0)) throw new Error("sprite.fps must be > 0.");
  const sheetOf = async (w: number, h: number, put: { input: Buffer; left: number; top: number; w: number; h: number }[]) => {
    const W = w, H = h;
    if (Math.max(W, H) > MAX_TEX) throw new Error(`The sprite sheet would be ${W}x${H}: too large (max ${MAX_TEX}). Use smaller frames or fewer of them.`);
    const rgba = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(put.map(p => ({ input: p.input, raw: { width: p.w, height: p.h, channels: 4 as const }, left: p.left, top: p.top }))).raw().toBuffer();
    return { rgba, W, H };
  };
  let fw: number, fh: number, cols: number, count: number, sheet: { rgba: Buffer; W: number; H: number };
  if (o.frames?.length) {
    const imgs = [];
    for (const p of o.frames) {
      if (!path.isAbsolute(p) || !fs.existsSync(p)) throw new Error(`Frame not found: "${p}" (use absolute paths).`);
      imgs.push(await loadRgba(p));
    }
    [fw, fh] = [imgs[0].w, imgs[0].h];
    const odd = imgs.findIndex(i => i.w !== fw || i.h !== fh);
    if (odd >= 0) throw new Error(`All frames must have the same size: frame 0 is ${fw}x${fh}, frame ${odd} is ${imgs[odd].w}x${imgs[odd].h}.`);
    count = imgs.length; cols = sp.cols ?? Math.max(1, Math.min(count, Math.floor(2048 / fw)));
    sheet = await sheetOf(cols * fw, Math.ceil(count / cols) * fh, imgs.map((im, i) => ({ input: im.rgba, left: (i % cols) * fw, top: Math.floor(i / cols) * fh, w: fw, h: fh })));
  } else {
    if (!o.image) throw new Error("Give image (a sprite sheet) or frames (a list of images).");
    if (!sp.cols || !sp.rows) throw new Error("A sprite sheet needs sprite:{cols, rows} = how many frames across and down.");
    const img = await loadRgba(o.image);
    if (img.w % sp.cols || img.h % sp.rows) throw new Error(`The sheet is ${img.w}x${img.h}px: not divisible by ${sp.cols} x ${sp.rows} frames.`);
    cols = sp.cols; fw = img.w / cols; fh = img.h / sp.rows; count = sp.count ?? cols * sp.rows;
    if (count < 1 || count > cols * sp.rows) throw new Error(`sprite.count must be 1..${cols * sp.rows}.`);
    sheet = await sheetOf(img.w, img.h, [{ input: img.rgba, left: 0, top: 0, w: img.w, h: img.h }]);
  }
  const base = uniqueBase(dir, slug(wanted));
  fs.mkdirSync(path.join(dir, "materials"), { recursive: true });
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  const frames = Array.from({ length: count }, (_, i) => ({ x: (i % cols) * fw, y: Math.floor(i / cols) * fh }));
  fs.writeFileSync(path.join(dir, "materials", base + ".tex"), await encodeTex(sheet.rgba, sheet.W, sheet.H, { mips: false, sprite: { w: fw, h: fh, frames, seconds: 1 / fps } }));
  await sharp(sheet.rgba, { raw: { width: sheet.W, height: sheet.H, channels: 4 } }).png().toFile(path.join(dir, "materials", base + ".png"));
  fs.writeFileSync(path.join(dir, "materials", base + ".tex-json"), JSON.stringify({
    bleedtransparentcolors: true, clampuvs: true, format: "rgba8888", nonpoweroftwo: true,
    spritesheet: true, spritesheetsequences: [{ width: fw, height: fh, frames: count, duration: count / fps }],
  }, null, "\t"));
  // what the editor writes for an animated texture: genericimage2 with the spritesheet combo, a model with the frame size
  fs.writeFileSync(path.join(dir, "materials", base + ".json"), JSON.stringify({
    passes: [{ blending: "translucent", combos: { spritesheet: 1, version: 2 }, cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled", shader: "genericimage2", textures: [base] }],
  }, null, "\t"));
  fs.writeFileSync(path.join(dir, "models", base + ".json"), JSON.stringify({ height: fh, material: `materials/${base}.json`, nopadding: true, width: fw }, null, "\t"));
  return { base, w: fw, h: fh, model: `models/${base}.json` };
}

/**
 * Video layer: an .mp4 copied to materials/<name>.mp4 with the .tex wrapper, material and model the editor writes. The layer is as big as the video.
 * ponytail: mp4 only (the codec must play on the viewer's Windows); the sound track plays with the layer; loop / play control is SceneScript (IVideoTexture).
 */
export function importVideo(dir: string, file: string, wanted: string): TexAsset {
  if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error(`Video not found: "${file}" (use an absolute path).`);
  const mp4 = fs.readFileSync(file);
  const { w, h } = mp4Size(mp4);
  const base = uniqueBase(dir, slug(wanted));
  fs.mkdirSync(path.join(dir, "materials"), { recursive: true });
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "materials", base + ".mp4"), mp4);
  fs.writeFileSync(path.join(dir, "materials", base + ".tex"), encodeVideoTex(mp4, w, h));
  fs.writeFileSync(path.join(dir, "materials", base + ".tex-json"), JSON.stringify({ bleedtransparentcolors: true, clampuvs: true, format: "rgba8888", halfmip: true, nonpoweroftwo: true }, null, "\t"));
  fs.writeFileSync(path.join(dir, "materials", base + ".json"), JSON.stringify({
    passes: [{ blending: "translucent", combos: {}, cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled", shader: "genericimage4", textures: [base] }],
  }, null, "\t"));
  fs.writeFileSync(path.join(dir, "models", base + ".json"), JSON.stringify({ height: h, material: `materials/${base}.json`, nopadding: true, width: w }, null, "\t"));
  return { base, w, h, model: `models/${base}.json` };
}

/* ====================================================================
   Scene / project creation
   ==================================================================== */

export function defaultGeneral(w: number, h: number, clear = "0.00000 0.00000 0.00000"): Record<string, any> {
  return {
    ambientcolor: "0.30000 0.30000 0.30000", bloom: false, bloomhdrfeather: 0.1, bloomhdriterations: 8, bloomhdrscatter: 1.619,
    bloomhdrstrength: 2.0, bloomhdrthreshold: 1.0, bloomstrength: 2.0, bloomthreshold: 0.65, bloomtint: "1.00000 1.00000 1.00000",
    camerafade: true, cameraparallax: false, cameraparallaxamount: 0.5, cameraparallaxdelay: 0.1, cameraparallaxmouseinfluence: 0.5,
    camerapreview: true, camerashake: false, camerashakeamplitude: 0.5, camerashakeroughness: 1.0, camerashakespeed: 3.0,
    clearcolor: clear, clearenabled: true, farz: 10000.0, fov: 50.0, hdr: false, nearz: 0.01,
    orthogonalprojection: { height: h, width: w }, skylightcolor: "0.30000 0.30000 0.30000", zoom: 1.0,
    // particle gravity / wind and the perspective fov: present in every recent editor scene
    gravitydirection: "0.00000 -1.00000 0.00000", gravitystrength: 1.0, perspectiveoverridefov: 90.0,
    winddirection: "0.70700 0.70700 0.00000", windenabled: false, windstrength: 1.0,
  };
}

export interface LayerOpts {
  /** image file; with `sprite` it is a sprite sheet. Optional when `frames` is given */
  image?: string; name?: string;
  /** several same-size images = the frames of an animated texture (sprite: {fps} sets the speed) */
  frames?: string[]; sprite?: SpriteOpts;
  /** an .mp4 file: a VIDEO layer */
  video?: string;
  /** canvas pixels, origin TOP-LEFT, y down. Default: canvas centre */
  x?: number; y?: number;
  /** which point of the layer lands on (x,y): center, top-left, bottom, ... */
  anchor?: string;
  /** final displayed size in canvas px (keeps aspect if only one is given) */
  width?: number; height?: number;
  /** multiplier on the natural size (number or [sx, sy]) - ignored when width/height/fit is given */
  scale?: number | number[];
  /** "cover" | "contain" | "stretch" relative to the canvas */
  fit?: "cover" | "contain" | "stretch";
  /** degrees, counter-clockwise */
  rotation?: number;
  alpha?: any; color?: any; brightness?: any; blend?: string | number;
  parallax_depth?: number | number[];
  parent?: string | number; visible?: any; position?: Place; locked?: boolean;
  /** texture repeats at the edges instead of clamping (the scroll effect needs it) */
  tile?: boolean;
  /** "Limit iCUE & Chroma to this layer": RGB keyboards / mice / LED strips mirror only this layer (the topmost one counts) */
  led?: boolean;
  /** key of a "texture" user property: the viewer picks their own image/video for this layer, the layer's picture stays the default */
  texture_property?: string;
}

/** Bind an image layer's texture to a user property of type scenetexture: the material pass gets "usertextures": [key] (what the editor writes). */
function bindTextureProperty(dir: string, obj: Obj, key: string) {
  const m = materialOf(dir, obj);
  if (!m) throw new Error(`"${obj.name}" cannot take a texture property: only plain image layers (not sprite sheets, solids or effect layers).`);
  bindProperty(dir, { property: key, label: String(obj.name), type: "texture" }, "");
  m.pass.usertextures = [key];
  m.save();
}

function applyCommon(ctx: SceneCtx, obj: Obj, o: Partial<LayerOpts>) {
  const d = ctx.dir;
  if (o.alpha !== undefined) obj.alpha = bindable(d, o.alpha, 1);
  if (o.color !== undefined) obj.color = typeof o.color === "string" || Array.isArray(o.color) ? colorStr(o.color) : bindable(d, o.color, "1 1 1");
  if (o.brightness !== undefined) obj.brightness = bindable(d, o.brightness, 1);
  if (o.blend !== undefined) obj.colorBlendMode = blendMode(o.blend);
  if (o.parallax_depth !== undefined) { const p = Array.isArray(o.parallax_depth) ? o.parallax_depth : [o.parallax_depth, o.parallax_depth]; obj.parallaxDepth = vecStr(p.slice(0, 2)); }
  if (o.visible !== undefined && o.visible !== true) obj.visible = bindable(d, o.visible, true);
  if (o.locked) obj.locktransforms = true;
  if (o.led) obj.ledsource = true;
}

export async function addImageLayerCore(ctx: SceneCtx, o: LayerOpts): Promise<{ obj: Obj; tex: TexAsset }> {
  const { scene, dir } = ctx;
  const cv = sceneSize(scene);
  const src = o.image ?? o.video ?? o.frames?.[0];
  if (!src) throw new Error("Give image (or frames for an animated texture, or video for an mp4).");
  const name = o.name ?? path.basename(src, path.extname(src));
  const tex = o.video ? importVideo(dir, o.video, name) : o.frames?.length || o.sprite ? await importSprite(dir, o, name) : await importTexture(dir, src, name, o.tile);

  let sx: number, sy: number;
  if (o.fit) {
    const k = o.fit === "cover" ? Math.max(cv.w / tex.w, cv.h / tex.h) : o.fit === "contain" ? Math.min(cv.w / tex.w, cv.h / tex.h) : 1;
    sx = o.fit === "stretch" ? cv.w / tex.w : k; sy = o.fit === "stretch" ? cv.h / tex.h : k;
  } else if (o.width || o.height) {
    sx = o.width ? o.width / tex.w : (o.height! / tex.h);
    sy = o.height ? o.height / tex.h : sx;
    if (!o.width) sx = sy;
  } else if (o.scale !== undefined) {
    const s = Array.isArray(o.scale) ? o.scale : [o.scale, o.scale];
    sx = s[0]; sy = s[1] ?? s[0];
  } else { sx = 1; sy = 1; }
  const obj = placeLayer(ctx, o, tex.model, name, tex.w, tex.h, sx, sy);
  if (o.texture_property) bindTextureProperty(dir, obj, o.texture_property);
  return { obj, tex };
}

/** Shared by every placed layer: anchor point (canvas px, top-left origin) + parent -> local origin, size, scale, rotation, common props, z-order. */
function placeLayer(ctx: SceneCtx, o: Partial<LayerOpts>, model: string, name: string, w: number, h: number, sx: number, sy: number): Obj {
  const { scene } = ctx;
  const cv = sceneSize(scene);
  const rot = o.rotation ?? 0;
  const parent = o.parent !== undefined ? findLayer(scene, o.parent) : undefined;
  const Pw = parent ? worldXf(scene, parent) : undefined;
  // world scale / rotation of the layer = given (local) values combined with the parent's
  const wsx = sx * (Pw?.sx ?? 1), wsy = sy * (Pw?.sy ?? 1), wrot = rot + (Pw?.rot ?? 0);
  const [cx, cy] = originForAnchor(o.x ?? cv.w / 2, cv.h - (o.y ?? cv.h / 2), w, h, wsx, wsy, wrot, o.anchor ?? "center");
  const local = localFromWorld(scene, parent, { x: cx, y: cy, sx: wsx, sy: wsy, rot: wrot });

  const obj: Obj = { castshadow: false, id: nextId(scene), image: model, name, origin: vecStr([local.x, local.y, 0]), size: vecStr([w, h]) };
  if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6) obj.scale = vecStr([sx, sy, 1]);
  if (Math.abs(rot) > 1e-9) obj.angles = anglesStr(rot);
  if (parent) obj.parent = parent.id;
  applyCommon(ctx, obj, o);
  insertAt(scene, obj, o.position ?? "top");
  return obj;
}

export interface UtilOpts extends Omit<LayerOpts, "image" | "fit" | "scale"> { kind: UtilKind }

/** Solid colour rectangle / post-process layer. No texture: `solid` and `compose` are sized rectangles (default: whole canvas), `fullscreen` has no geometry at all (like the editor writes it). */
export function addUtilLayerCore(ctx: SceneCtx, a: UtilOpts): Obj {
  const cv = sceneSize(ctx.scene);
  const name = a.name ?? { solid: "solid", fullscreen: "post-process", compose: "effect area" }[a.kind];
  if (a.kind === "fullscreen") {
    const obj: Obj = { id: nextId(ctx.scene), image: UTIL_MODELS.fullscreen, name, parallaxDepth: "0.00000 0.00000" };
    if (a.visible !== undefined && a.visible !== true) obj.visible = bindable(ctx.dir, a.visible, true);
    if (a.parent !== undefined) obj.parent = findLayer(ctx.scene, a.parent).id;
    insertAt(ctx.scene, obj, a.position ?? "top");
    return obj;
  }
  // solid colour is what the layer is for: default black (shadows, dimming, vignettes); WE would otherwise use its own default
  return placeLayer(ctx, { ...a, color: a.color ?? (a.kind === "solid" ? "#000000" : undefined) }, UTIL_MODELS[a.kind], name, a.width ?? cv.w, a.height ?? cv.h, 1, 1);
}

export function addUtilLayer(project: string, a: UtilOpts): string {
  const ctx = openScene(project);
  const obj = addUtilLayerCore(ctx, a);
  saveScene(ctx);
  const what = {
    solid: "Solid colour layer. Soften or shape it with add_effect (e.g. opacity + a gradient/radial mask for vignettes and shadows) or use blend/alpha.",
    fullscreen: "Post-process layer: every effect you add to it (add_effect) is applied to ALL layers below it in the z-order (mask shapes use canvas px). Keep it above what it should affect.",
    compose: "Effect area: effects added to it (add_effect) are applied to everything below it, but only inside this rectangle.",
  }[a.kind];
  return `Added [${obj.id}] "${obj.name}" (${a.kind}).\n${describeLayer(ctx.scene, obj)}\n${what}`;
}

export async function createSceneWallpaper(a: {
  name: string; title?: string; description?: string; image?: string; width?: number; height?: number;
  fit?: "cover" | "contain" | "stretch"; background_color?: string;
}): Promise<string> {
  const w = a.width ?? 1920, h = a.height ?? 1080;
  const slugName = slug(a.name);
  const dir = path.join(MY_PROJECTS_PATH, slugName);
  if (fs.existsSync(dir)) return `Project "${slugName}" already exists at ${dir}`;
  if (a.image && (!path.isAbsolute(a.image) || !fs.existsSync(a.image))) return `Image not found: "${a.image}" (use an absolute path).`;
  fs.mkdirSync(dir, { recursive: true });
  const title = a.title ?? a.name;
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({
    contentrating: "Everyone", description: a.description ?? "", file: "scene.json",
    general: { properties: { schemecolor: { order: 0, text: "ui_browse_properties_scheme_color", type: "color", value: "0.41961 0.42745 0.43922" } } },
    preview: "preview.jpg", tags: [], title, type: "scene", version: 0,
  }, null, "\t"));
  const scene = {
    camera: { center: "0.00000 0.00000 0.00000", eye: "0.00000 0.00000 1.00000", up: "0.00000 1.00000 0.00000" },
    general: defaultGeneral(w, h, a.background_color ? colorStr(a.background_color) : undefined),
    objects: [] as Obj[], version: 5,
  };
  const ctx: SceneCtx = { dir, file: path.join(dir, "scene.json"), scene };
  let info = "Empty scene (no layers yet). Use add_layer to add images.";
  if (a.image) {
    const { obj, tex } = await addImageLayerCore(ctx, { image: a.image, name: "background", fit: a.fit ?? "cover" });
    info = `Background layer "${obj.name}" (id ${obj.id}) from ${tex.w}x${tex.h} image, fit ${a.fit ?? "cover"}.`;
    await sharp(a.image, { failOn: "none" }).resize(640, 360, { fit: "cover" }).jpeg({ quality: 85 }).toFile(path.join(dir, "preview.jpg"));
  } else {
    await sharp({ create: { width: 640, height: 360, channels: 3, background: "#222" } }).jpeg().toFile(path.join(dir, "preview.jpg"));
  }
  saveScene(ctx);
  return [
    `Created scene wallpaper "${title}" at ${dir}`,
    `Canvas ${w}x${h} px. ${info}`,
    "Textures are already converted to .tex - no need to open the editor first.",
    "Next: add_layer / add_effect / create_mask / animate_layer, then preview_scene and apply_wallpaper.",
  ].join("\n");
}

/** A VIDEO wallpaper (what the editor makes when you drop a video on "Create Wallpaper"): project.json type "video" + the file, no scene or layers. */
export async function createVideoWallpaper(a: { name: string; video: string; title?: string; description?: string; preview?: string; tags?: string[] }): Promise<string> {
  if (!path.isAbsolute(a.video) || !fs.existsSync(a.video)) return `Video not found: "${a.video}" (use an absolute path).`;
  const ext = path.extname(a.video).toLowerCase();
  if (![".mp4", ".webm", ".avi", ".m4v", ".mov", ".wmv"].includes(ext)) return `Unsupported video type "${ext}" (mp4, webm, avi, m4v, mov, wmv; the Workshop accepts only mp4).`;
  if (a.preview && (!path.isAbsolute(a.preview) || !fs.existsSync(a.preview))) return `Preview image not found: "${a.preview}" (use an absolute path).`;
  const slugName = slug(a.name), dir = path.join(MY_PROJECTS_PATH, slugName);
  if (fs.existsSync(dir)) return `Project "${slugName}" already exists at ${dir}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = slugName + ext;
  fs.copyFileSync(a.video, path.join(dir, file));
  // ponytail: no frame grab without ffmpeg - the preview is the given image or a dark placeholder (the editor replaces it when you publish)
  const src = a.preview ? sharp(a.preview, { failOn: "none" }).resize(640, 360, { fit: "cover" }) : sharp({ create: { width: 640, height: 360, channels: 3, background: "#222" } });
  await src.jpeg({ quality: 85 }).toFile(path.join(dir, "preview.jpg"));
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({
    contentrating: "Everyone", description: a.description ?? "", file,
    general: { properties: { schemecolor: { order: 0, text: "ui_browse_properties_scheme_color", type: "color", value: "0.41961 0.42745 0.43922" } } },
    preview: "preview.jpg", tags: a.tags ?? [], title: a.title ?? a.name, type: "video", version: 0,
  }, null, "\t"));
  return [
    `Created VIDEO wallpaper "${a.title ?? a.name}" at ${dir} (${file}, ${(fs.statSync(path.join(dir, file)).size / 1048576).toFixed(1)} MB).`,
    ext === ".mp4" ? "" : "Note: the Workshop only accepts mp4.",
    "A video wallpaper has no layers or effects. For effects, particles, lights or user switches on top of a video, use create_scene_wallpaper + add_layer {video}.",
  ].filter(Boolean).join("\n");
}

/* ====================================================================
   get_scene
   ==================================================================== */

function bindText(v: any): string {
  if (v && typeof v === "object" && "user" in v) {
    const u = typeof v.user === "object" ? `${v.user.name}${v.user.condition !== undefined ? "=" + v.user.condition : ""}` : v.user;
    return `{property ${u}, default ${JSON.stringify(v.value)}}`;
  }
  if (v && typeof v === "object" && "script" in v) return "{script}";
  return JSON.stringify(v);
}

export function describeLayer(scene: any, o: Obj): string {
  const cv = sceneSize(scene);
  const kind = kindOf(o);
  const xf = worldXf(scene, o);
  const [px, py] = sceneToPx(xf.x, xf.y, cv.h);
  const size = parseVec(o.size, [0, 0]);
  const parts: string[] = [`[${o.id}] "${o.name}" ${kind}`];
  if (kind === "image") parts.push(`${path.basename(String(o.image), ".json")}`);
  if (kind === "particle") parts.push(path.basename(String(o.particle)));
  if (kind === "text") parts.push(`"${typeof o.text === "object" ? (o.text.script ? "<script>" : o.text.value) : o.text}" font ${Math.round(parseVec(o.pointsize, [32])[0] * PT_PX * Math.abs(xf.sy))}px`);
  if (kind === "sound") parts.push(String(o.sound?.[0] ?? ""));
  if (utilKind(o) === "fullscreen") parts.push("post-process: whole canvas, affects every layer below it");
  else if (kind === "image") {
    const bw = Math.abs(size[0] * xf.sx), bh = Math.abs(size[1] * xf.sy); // a negative scale mirrors the layer; the box stays positive
    parts.push(`centre (${px.toFixed(0)}, ${py.toFixed(0)})px`, `size ${size[0]}x${size[1]}`, `on-screen ${bw.toFixed(0)}x${bh.toFixed(0)}`);
    parts.push(`bbox x ${(px - bw / 2).toFixed(0)}..${(px + bw / 2).toFixed(0)} y ${(py - bh / 2).toFixed(0)}..${(py + bh / 2).toFixed(0)} (unrotated)`);
  } else if (kind === "text") parts.push(`${o.horizontalalign ?? "center"}-aligned, anchor (${px.toFixed(0)}, ${py.toFixed(0)})px`);
  else if (o.origin !== undefined) parts.push(`at (${px.toFixed(0)}, ${py.toFixed(0)})px`);
  if (Math.abs(xf.sx - 1) > 1e-3 || Math.abs(xf.sy - 1) > 1e-3) parts.push(`scale ${xf.sx.toFixed(3)}x${xf.sy.toFixed(3)}`);
  if (Math.abs(xf.rot) > 1e-3) parts.push(`rot ${xf.rot.toFixed(1)}deg`);
  const still = (v: any) => (v && typeof v === "object" && v.animation ? v.value : v);   // keyframes are listed as animated(...) below
  if (o.alpha !== undefined && o.alpha !== 1) parts.push(`alpha ${bindText(still(o.alpha))}`);
  if (o.colorBlendMode) parts.push(`blend ${Object.entries(BLEND_MODES).find(([, n]) => n === o.colorBlendMode)?.[0] ?? o.colorBlendMode}`);
  if (o.color !== undefined && !/^1(\.0+)? 1(\.0+)? 1(\.0+)?$/.test(String(typeof o.color === "object" ? o.color.value : o.color))) parts.push(`color ${bindText(still(o.color))}`);
  if (o.parallaxDepth !== undefined) parts.push(`parallax ${typeof o.parallaxDepth === "string" ? o.parallaxDepth : bindText(o.parallaxDepth)}`);
  if (o.visible !== undefined && o.visible !== true) parts.push(`visible ${bindText(o.visible)}`);
  if (o.locktransforms) parts.push("locked");
  if (o.ledsource) parts.push("RGB source (iCUE / Chroma)");
  if (o.puppet || o.animationlayers) parts.push("puppet-anim");
  const anim = ["origin", "angles", "scale", "alpha", "color", "brightness", "size"].filter(k => o[k]?.animation).map(k => `${k}:${o[k].animation.options?.mode}`);
  if (anim.length) parts.push(`animated(${anim.join(",")})`);
  if (Array.isArray(o.effects) && o.effects.length) {
    parts.push("effects: " + o.effects.map((e: any, i: number) => {
      const nm = String(e.file ?? "").replace(/^effects\//, "").replace(/\/effect\.json$/, "");
      const masks = (e.passes ?? []).flatMap((p: any) => (p.textures ?? []).filter((t: any) => t && String(t).startsWith("masks/"))).length;
      return `#${i}${e.id !== undefined ? "(id" + e.id + ")" : ""} ${nm}${masks ? " +mask" : ""}${e.visible === false ? " (hidden)" : ""}`;
    }).join("; "));
  }
  return parts.join(" | ");
}

export function getScene(project: string): string {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  const cv = sceneSize(scene);
  const g = scene.general ?? {};
  const val = (v: any) => (v && typeof v === "object" && "value" in v ? bindText(v) : JSON.stringify(v));
  const lines: string[] = [];
  lines.push(`Scene "${path.basename(dir)}" - canvas ${cv.w}x${cv.h} px (positions below are px from the TOP-LEFT, y down; use the same in add_layer/update_layer)`);
  lines.push(`General: clearcolor ${val(g.clearcolor)} | bloom ${g.bloom ? `on (strength ${g.bloomstrength}, threshold ${g.bloomthreshold})` : "off"} | parallax ${g.cameraparallax ? `on (amount ${g.cameraparallaxamount})` : "off"} | camera shake ${g.camerashake ? "on" : "off"} | hdr ${g.hdr ? "on" : "off"}`);
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf-8").replace(/^\uFEFF/, ""));
    const props = Object.entries(pj.general?.properties ?? {}).map(([k, v]: [string, any]) => `${k}(${v.type}${v.value !== undefined ? "=" + JSON.stringify(v.value) : ""})`);
    if (props.length) lines.push(`User properties: ${props.join(", ")}`);
  } catch { /* no project.json */ }
  const objs: Obj[] = scene.objects;
  lines.push(`Layers (${objs.length}), bottom -> top (the last one is drawn on top):`);
  const byParent = new Map<any, Obj[]>();
  for (const o of objs) { const k = o.parent !== undefined && objs.some(p => p.id === o.parent) ? o.parent : "root"; (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(o); }
  const walk = (key: any, depth: number) => {
    for (const o of byParent.get(key) ?? []) {
      lines.push(`${"  ".repeat(depth + 1)}${describeLayer(scene, o)}`);
      walk(o.id, depth + 1);
    }
  };
  walk("root", 0);
  return lines.join("\n");
}

/* ====================================================================
   Layer editing
   ==================================================================== */

export async function addLayer(project: string, o: LayerOpts): Promise<string> {
  const ctx = openScene(project);
  const { obj, tex } = await addImageLayerCore(ctx, o);
  saveScene(ctx);
  const cv = sceneSize(ctx.scene);
  return `Added layer [${obj.id}] "${obj.name}" (${tex.w}x${tex.h} texture).\n${describeLayer(ctx.scene, obj)}\nCanvas ${cv.w}x${cv.h}. Verify with preview_scene.`;
}

export interface LayerUpdate {
  name?: string; x?: number; y?: number; anchor?: string; dx?: number; dy?: number;
  width?: number; height?: number; scale?: number | number[]; scale_by?: number; rotation?: number; rotate_by?: number;
  alpha?: any; color?: any; brightness?: any; blend?: string | number; parallax_depth?: number | number[];
  visible?: any; locked?: boolean; parent?: string | number | null; move_to?: Place; raw?: Record<string, any>;
  /** image layers: receive scene lights (the LIGHTING combo of their material) */
  lighting?: boolean;
  /** RGB hardware (iCUE, Chroma) shows only this layer */
  led?: boolean;
  /** image layers: bind the texture to a "texture" user property (the viewer picks the image/video) */
  texture_property?: string;
}

export function updateLayer(project: string, layer: string | number, u: LayerUpdate): string {
  const ctx = openScene(project);
  const { scene } = ctx;
  const cv = sceneSize(scene);
  const obj = findLayer(scene, layer);
  const kind = kindOf(obj);
  const changes: string[] = [];
  const size = parseVec(obj.size, [0, 0]);
  if (utilKind(obj) === "fullscreen" && [u.x, u.y, u.dx, u.dy, u.scale, u.width, u.height, u.scale_by, u.rotation, u.rotate_by].some(v => v !== undefined))
    throw new Error(`"${obj.name}" is a full-canvas post-process layer: it has no position or size. Use add_effect_layer kind:"area" for a rectangle.`);
  if (u.name !== undefined) { obj.name = u.name; changes.push(`name=${u.name}`); }

  // reparent first, keeping the world position
  let w: Xf = worldXf(scene, obj);
  if (u.parent !== undefined) {
    const np = u.parent === null ? undefined : findLayer(scene, u.parent);
    if (np && np.id === obj.id) throw new Error("A layer cannot be its own parent.");
    for (let p: Obj | undefined = np; p; p = p.parent !== undefined ? scene.objects.find((q: Obj) => q.id === p!.parent) : undefined)
      if (p.id === obj.id) throw new Error("That would create a parent loop.");
    const l = localFromWorld(scene, np, w);
    if (np) obj.parent = np.id; else delete obj.parent;
    setLocal(obj, l);
    changes.push(np ? `parent=${np.id}` : "parent=none");
  }

  // transform requests are resolved in WORLD terms, then converted back to local
  const Pw = obj.parent !== undefined ? worldXf(scene, scene.objects.find((p: Obj) => p.id === obj.parent)!) : undefined;
  w = worldXf(scene, obj);
  let { sx, sy, rot } = { sx: w.sx, sy: w.sy, rot: w.rot };
  if (u.scale !== undefined) { const s = Array.isArray(u.scale) ? u.scale : [u.scale, u.scale]; sx = s[0] * (Pw?.sx ?? 1); sy = (s[1] ?? s[0]) * (Pw?.sy ?? 1); }
  if (u.width || u.height) {
    if (!size[0] || !size[1]) throw new Error("This layer has no size; width/height do not apply.");
    sx = u.width ? u.width / size[0] : u.height! / size[1];
    sy = u.height ? u.height / size[1] : sx;
  }
  if (u.scale_by !== undefined) { sx *= u.scale_by; sy *= u.scale_by; }
  if (u.rotation !== undefined) rot = u.rotation + (Pw?.rot ?? 0);
  if (u.rotate_by !== undefined) rot += u.rotate_by;
  // The anchor point (default centre) stays where it is unless x/y/dx/dy move it; scale and rotation act about it.
  const anchor = u.anchor ?? "center";
  const [ax, ay] = anchorPoint(w, size, anchor);
  let tx = u.x !== undefined ? u.x : ax, ty = u.y !== undefined ? cv.h - u.y : ay;
  if (u.dx !== undefined) tx += u.dx;
  if (u.dy !== undefined) ty -= u.dy;
  const [cx, cy] = originForAnchor(tx, ty, size[0] || 1, size[1] || 1, sx, sy, rot, anchor);
  const touched = [u.x, u.y, u.dx, u.dy, u.scale, u.width, u.height, u.scale_by, u.rotation, u.rotate_by].some(v => v !== undefined);
  if (touched) {
    const par = obj.parent !== undefined ? scene.objects.find((p: Obj) => p.id === obj.parent) : undefined;
    const l = localFromWorld(scene, par, { x: cx, y: cy, sx, sy, rot });
    setLocal(obj, l);
    const [px, py] = sceneToPx(cx, cy, cv.h);
    changes.push(`centre (${px.toFixed(1)}, ${py.toFixed(1)})px, scale ${sx.toFixed(4)}x${sy.toFixed(4)}, rot ${rot.toFixed(2)}deg`);
  }

  if (u.alpha !== undefined) { obj.alpha = bindable(ctx.dir, u.alpha, 1); changes.push("alpha"); }
  if (u.color !== undefined) { obj.color = typeof u.color === "string" || Array.isArray(u.color) ? colorStr(u.color) : bindable(ctx.dir, u.color, "1 1 1"); changes.push("color"); }
  if (u.brightness !== undefined) { obj.brightness = bindable(ctx.dir, u.brightness, 1); changes.push("brightness"); }
  if (u.blend !== undefined) { obj.colorBlendMode = blendMode(u.blend); changes.push(`blend=${u.blend}`); }
  if (u.parallax_depth !== undefined) { const p = Array.isArray(u.parallax_depth) ? u.parallax_depth : [u.parallax_depth, u.parallax_depth]; obj.parallaxDepth = vecStr(p.slice(0, 2)); changes.push("parallax"); }
  if (u.visible !== undefined) { obj.visible = bindable(ctx.dir, u.visible, true); changes.push("visible"); }
  if (u.locked !== undefined) { obj.locktransforms = u.locked; changes.push(`locked=${u.locked}`); }
  if (u.led !== undefined) { obj.ledsource = u.led; changes.push(`led=${u.led}`); }
  if (u.lighting !== undefined) {
    const r = setLighting(ctx.dir, obj, u.lighting);
    if (r === "unsupported") throw new Error(`"${obj.name}" cannot be lit: only image layers with a plain image material (not sprite sheets, solids or effect layers).`);
    changes.push(`lighting=${u.lighting}`);
  }
  if (u.texture_property) { bindTextureProperty(ctx.dir, obj, u.texture_property); changes.push(`texture property ${u.texture_property}`); }
  if (u.raw) for (const [k, v] of Object.entries(u.raw)) { if (k === "id") continue; obj[k] = v; changes.push(`raw ${k}`); }
  if (u.move_to !== undefined) {
    scene.objects.splice(scene.objects.indexOf(obj), 1);
    insertAt(scene, obj, u.move_to);
    changes.push(`z-order -> index ${scene.objects.indexOf(obj)}`);
  }
  if (!changes.length) return `Nothing to change for [${obj.id}] "${obj.name}" (${kind}).`;
  saveScene(ctx);
  return `Updated [${obj.id}] "${obj.name}": ${changes.join("; ")}\n${describeLayer(scene, obj)}`;
}

export function removeLayer(project: string, layer: string | number, with_children = true): string {
  const ctx = openScene(project);
  const { scene } = ctx;
  const obj = findLayer(scene, layer);
  const ids = new Set<number>([obj.id]);
  if (with_children) {
    let grew = true;
    while (grew) { grew = false; for (const o of scene.objects) if (o.parent !== undefined && ids.has(o.parent) && !ids.has(o.id)) { ids.add(o.id); grew = true; } }
  } else for (const o of scene.objects) if (o.parent === obj.id) { // keep children where they are
    const l = localFromWorld(scene, undefined, worldXf(scene, o)); delete o.parent; setLocal(o, l);
  }
  const removed = scene.objects.filter((o: Obj) => ids.has(o.id));
  scene.objects = scene.objects.filter((o: Obj) => !ids.has(o.id));
  saveScene(ctx);
  return `Removed ${removed.length} layer(s): ${removed.map((o: Obj) => `[${o.id}] ${o.name}`).join(", ")}. (Texture files stay in the project folder.)`;
}

export function duplicateLayer(project: string, layer: string | number, a: { name?: string; dx?: number; dy?: number } = {}): string {
  const ctx = openScene(project);
  const { scene } = ctx;
  const src = findLayer(scene, layer);
  const idMap = new Map<number, number>();
  let id = nextId(scene);
  const clone = (o: Obj): Obj => {
    const c: Obj = JSON.parse(JSON.stringify(o));
    idMap.set(o.id, id); c.id = id++;
    // effects / passes / animation layers need unique ids too
    const renum = (v: any) => { if (Array.isArray(v)) v.forEach(renum); else if (v && typeof v === "object") { if (typeof v.id === "number" && v !== c) v.id = id++; for (const k in v) renum(v[k]); } };
    for (const k of ["effects", "animationlayers"]) if (c[k]) renum(c[k]);
    return c;
  };
  const out: Obj[] = [];
  const first = clone(src);
  first.name = a.name ?? `${src.name} copy`;
  if (a.dx || a.dy) { const o = parseVec(first.origin, [0, 0, 0]); first.origin = vecStr([o[0] + (a.dx ?? 0), o[1] - (a.dy ?? 0), o[2] ?? 0]); }
  out.push(first);
  const walk = (parentId: number) => { for (const o of scene.objects.filter((x: Obj) => x.parent === parentId)) { const c = clone(o); c.parent = idMap.get(parentId); out.push(c); walk(o.id); } };
  walk(src.id);
  const at = scene.objects.indexOf(src) + 1;
  scene.objects.splice(at, 0, ...out);
  saveScene(ctx);
  return `Duplicated [${src.id}] "${src.name}" -> [${first.id}] "${first.name}" (${out.length} layer(s) incl. children), placed just above the original.`;
}

/* ====================================================================
   Group / text / sound
   ==================================================================== */

export function addGroup(project: string, a: { name: string; x?: number; y?: number; rotation?: number; scale?: number; parent?: string | number; children?: (string | number)[]; position?: Place }): string {
  const ctx = openScene(project);
  const { scene } = ctx;
  const cv = sceneSize(scene);
  const x = a.x ?? cv.w / 2, y = a.y ?? cv.h / 2;
  const parent = a.parent !== undefined ? findLayer(scene, a.parent) : undefined;
  const w: Xf = { x, y: cv.h - y, sx: a.scale ?? 1, sy: a.scale ?? 1, rot: a.rotation ?? 0 };
  const l = localFromWorld(scene, parent, w);
  const g: Obj = { id: nextId(scene), name: a.name, origin: vecStr([l.x, l.y, 0]) };
  if (parent) g.parent = parent.id;
  if (Math.abs(l.rot) > 1e-9) g.angles = anglesStr(l.rot);
  if (Math.abs(l.sx - 1) > 1e-6) g.scale = vecStr([l.sx, l.sx, 1]);
  insertAt(scene, g, a.position ?? "top");
  const moved: string[] = [];
  for (const ref of a.children ?? []) {
    const c = findLayer(scene, ref);
    const cw = worldXf(scene, c);
    const cl = localFromWorld(scene, g, cw);
    c.parent = g.id; setLocal(c, cl);
    moved.push(`[${c.id}] ${c.name}`);
  }
  saveScene(ctx);
  return `Added group [${g.id}] "${g.name}" pivot at (${x}, ${y})px.${moved.length ? ` Children attached: ${moved.join(", ")}.` : ""}\nRotate/scale/animate the group to move all children around that pivot (e.g. animate_layer sway on the group).`;
}

const CLOCK_SCRIPT = (kind: string) => `'use strict';
export var scriptProperties = createScriptProperties()
  .addCheckbox({ name: 'use24', label: '24 hour clock', value: true })
  .addCheckbox({ name: 'seconds', label: 'Show seconds', value: false })
  .finish();
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad = n => ('00' + n).slice(-2);
export function update(value) {
  const t = new Date();
  const kind = '${kind}';
  if (kind === 'date') return t.getDate() + ' ' + MONTHS[t.getMonth()] + ' ' + t.getFullYear();
  if (kind === 'day') return DAYS[t.getDay()];
  let h = t.getHours(), suffix = '';
  if (!scriptProperties.use24) { suffix = h >= 12 ? ' PM' : ' AM'; h = h % 12 || 12; } else h = pad(h);
  return h + ':' + pad(t.getMinutes()) + (scriptProperties.seconds ? ':' + pad(t.getSeconds()) : '') + suffix;
}
`;

export function addText(project: string, a: {
  text?: string; dynamic?: "clock" | "date" | "day"; name?: string; x?: number; y?: number; size?: number; color?: any; font?: string;
  align?: "left" | "center" | "right"; padding?: number; max_width?: number; alpha?: any; rotation?: number; parent?: string | number; position?: Place; visible?: any;
}): string {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  const cv = sceneSize(scene);
  const em = a.size ?? 64;
  const pt = +(em / PT_PX).toFixed(2);
  const content = a.dynamic ? "" : (a.text ?? "Text");
  const lines = (a.dynamic ? "00:00:00" : content).split("\n");
  const pad = a.padding ?? 32;
  // WE re-measures the box when it loads (size is only a hint), so this estimate just needs to be close.
  // ponytail: ~0.56 em per character is Arial's average; exact widths would need the font metrics.
  const textW = Math.max(...lines.map(l => l.length)) * 0.56 * em;
  const width = Math.ceil(Math.min(textW, a.max_width ?? Infinity) + pad * 2);
  const height = Math.ceil(lines.length * 1.15 * em + pad * 2);
  const parent = a.parent !== undefined ? findLayer(scene, a.parent) : undefined;
  const l = localFromWorld(scene, parent, { x: a.x ?? cv.w / 2, y: cv.h - (a.y ?? cv.h / 2), sx: 1, sy: 1, rot: a.rotation ?? 0 });
  const t: Obj = {
    anchor: "none", angles: anglesStr(l.rot), backgroundbrightness: 1, backgroundcolor: "0.00000 0.00000 0.00000", blockalign: false,
    castshadow: false, color: isPropSpec(a.color) ? bindable(dir, a.color, "1 1 1") : colorStr(a.color ?? "#ffffff"),
    depthtest: "disabled", font: a.font ?? "systemfont_arial", horizontalalign: a.align ?? "center", id: nextId(scene),
    limitrows: false, limituseellipsis: false, limitwidth: a.max_width !== undefined, maxrows: 0, maxwidth: a.max_width ?? 0, name: a.name ?? (a.dynamic ?? content.slice(0, 24)),
    opaquebackground: false, origin: vecStr([l.x, l.y, 0]), padding: pad, pointsize: pt, scale: "1.00000 1.00000 1.00000",
    size: vecStr([width, height]), text: a.dynamic ? { script: CLOCK_SCRIPT(a.dynamic), scriptproperties: {}, value: `<${a.dynamic}>` } : content,
    verticalalign: "center",
  };
  if (parent) t.parent = parent.id;
  if (a.alpha !== undefined) t.alpha = bindable(dir, a.alpha, 1);
  if (a.visible !== undefined && a.visible !== true) t.visible = bindable(dir, a.visible, true);
  insertAt(scene, t, a.position ?? "top");
  saveScene(ctx);
  return `Added ${a.dynamic ? a.dynamic + " (live)" : "text"} layer [${t.id}] "${t.name}", ${t.horizontalalign}-aligned at (${a.x ?? cv.w / 2}, ${a.y ?? cv.h / 2})px, font ${em}px (${pt}pt). ` +
    `The point (x, y) is the ${t.horizontalalign === "center" ? "centre" : t.horizontalalign + " edge"} of the text; WE sizes the box around the text itself. Font "${t.font}": systemfont_<name> (arial, cambria, ...) or a project font path (fonts/x.ttf).`;
}

export function addSound(project: string, a: { file: string; name?: string; volume?: any; mode?: "loop" | "random"; min_time?: number; max_time?: number }): string {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  if (!path.isAbsolute(a.file) || !fs.existsSync(a.file)) throw new Error(`Audio file not found: "${a.file}" (use an absolute path).`);
  fs.mkdirSync(path.join(dir, "sounds"), { recursive: true });
  const fname = path.basename(a.file);
  fs.copyFileSync(a.file, path.join(dir, "sounds", fname));
  const s: Obj = {
    id: nextId(scene), maxtime: a.max_time ?? 5, mintime: a.min_time ?? 1, muteineditor: true, name: a.name ?? fname,
    playbackmode: a.mode ?? "loop", sound: [`sounds/${fname}`], startsilent: false, volume: bindable(dir, a.volume ?? 0.5, 0.5),
  };
  insertAt(scene, s, "top");
  saveScene(ctx);
  return `Added sound [${s.id}] "${s.name}" (${s.playbackmode}, volume ${bindText(s.volume)}). Copied to sounds/${fname}.`;
}

/* ====================================================================
   Scene settings (typed) + raw edit
   ==================================================================== */

export interface SceneSettings {
  clear_color?: any;
  bloom?: { enabled?: boolean; strength?: number; threshold?: number; tint?: string; hdr?: { strength?: number; scatter?: number; threshold?: number; smoothing?: number; iterations?: number } };
  parallax?: { enabled?: boolean; amount?: number; delay?: number; mouse_influence?: number };
  camera_shake?: { enabled?: boolean; amplitude?: number; roughness?: number; speed?: number };
  hdr?: boolean; ambient_color?: string; skylight_color?: string; zoom?: number; camera_fade?: boolean;
}

export function sceneSettings(project: string, s: SceneSettings): string {
  const ctx = openScene(project);
  const g = (ctx.scene.general = ctx.scene.general ?? {});
  const ch: string[] = [];
  const set = (k: string, v: any) => { g[k] = v; ch.push(`${k}=${bindText(v)}`); };
  if (s.clear_color !== undefined) set("clearcolor", typeof s.clear_color === "string" || Array.isArray(s.clear_color) ? colorStr(s.clear_color) : bindable(ctx.dir, s.clear_color, "0 0 0"));
  if (s.bloom) {
    if (s.bloom.enabled !== undefined) set("bloom", s.bloom.enabled);
    if (s.bloom.strength !== undefined) set("bloomstrength", s.bloom.strength);
    if (s.bloom.threshold !== undefined) set("bloomthreshold", s.bloom.threshold);
    if (s.bloom.tint !== undefined) set("bloomtint", colorStr(s.bloom.tint));
    // HDR bloom: only seen by viewers with post-processing "Ultra"; the plain bloom values above stay what everyone else sees
    const h = s.bloom.hdr;
    if (h?.strength !== undefined) set("bloomhdrstrength", h.strength);
    if (h?.scatter !== undefined) set("bloomhdrscatter", h.scatter);
    if (h?.threshold !== undefined) set("bloomhdrthreshold", h.threshold);
    if (h?.smoothing !== undefined) set("bloomhdrfeather", h.smoothing);
    if (h?.iterations !== undefined) set("bloomhdriterations", h.iterations);
  }
  if (s.parallax) {
    if (s.parallax.enabled !== undefined) set("cameraparallax", s.parallax.enabled);
    // a layer without parallaxDepth is NOT fixed once parallax is on (and a group + its child would move twice): pin them explicitly
    if (s.parallax.enabled) for (const o of ctx.scene.objects as Obj[]) if (o.parallaxDepth === undefined && !o.sound) o.parallaxDepth = FIXED_DEPTH;
    if (s.parallax.amount !== undefined) set("cameraparallaxamount", s.parallax.amount);
    if (s.parallax.delay !== undefined) set("cameraparallaxdelay", s.parallax.delay);
    if (s.parallax.mouse_influence !== undefined) set("cameraparallaxmouseinfluence", s.parallax.mouse_influence);
  }
  if (s.camera_shake) {
    if (s.camera_shake.enabled !== undefined) set("camerashake", s.camera_shake.enabled);
    if (s.camera_shake.amplitude !== undefined) set("camerashakeamplitude", s.camera_shake.amplitude);
    if (s.camera_shake.roughness !== undefined) set("camerashakeroughness", s.camera_shake.roughness);
    if (s.camera_shake.speed !== undefined) set("camerashakespeed", s.camera_shake.speed);
  }
  if (s.hdr !== undefined) set("hdr", s.hdr);
  if (s.ambient_color !== undefined) set("ambientcolor", colorStr(s.ambient_color));
  if (s.skylight_color !== undefined) set("skylightcolor", colorStr(s.skylight_color));
  if (s.zoom !== undefined) set("zoom", s.zoom);
  if (s.camera_fade !== undefined) set("camerafade", s.camera_fade);
  if (!ch.length) return "No settings given.";
  saveScene(ctx);
  return `Updated scene settings:\n${ch.map(c => "  " + c).join("\n")}`;
}

export function modifyScene(project: string, generalSettings?: Record<string, unknown>, objectUpdates?: { index: number; properties: Record<string, unknown> }[]): string {
  const ctx = openScene(project);
  const changes: string[] = [];
  if (generalSettings) {
    ctx.scene.general = ctx.scene.general ?? {};
    for (const [k, v] of Object.entries(generalSettings)) { ctx.scene.general[k] = v; changes.push(`general.${k} = ${JSON.stringify(v)}`); }
  }
  for (const u of objectUpdates ?? []) {
    const obj = ctx.scene.objects[u.index];
    if (!obj) { changes.push(`Object ${u.index}: out of range`); continue; }
    for (const [k, v] of Object.entries(u.properties)) { obj[k] = v; changes.push(`object[${u.index}].${k} = ${JSON.stringify(v)}`); }
  }
  if (!changes.length) return "No changes.";
  saveScene(ctx);
  return `Updated scene.json:\n${changes.map(c => `  - ${c}`).join("\n")}`;
}
