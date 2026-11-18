import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { WE_PATH } from "./config";

import { listWallpapers } from "./tools/list";
import { getWallpaperInfo } from "./tools/info";
import { createWallpaper, TEMPLATE_NAMES } from "./tools/create";
import { readWallpaperFile } from "./tools/read";
import { writeWallpaperFile } from "./tools/write";
import { applyWallpaper } from "./tools/apply";
import { controlWallpaper } from "./tools/control";
import { captureWallpaper } from "./tools/capture";
import { importImage } from "./tools/import_image";
import { deleteWallpaper, deleteWallpaperFile } from "./tools/delete";
import { updateProperties } from "./tools/properties";
import {
  createSceneWallpaper, createVideoWallpaper, getScene, addLayer, updateLayer, removeLayer, duplicateLayer, addGroup, addText, addSound, sceneSettings, modifyScene, addUtilLayer,
} from "./tools/scene";
import { listEffectsTool, addEffect, updateEffect, removeEffect, createMask } from "./tools/fx";
import { animateLayer, ANIM_PRESETS, listParticles, addParticles } from "./tools/anim";
import { addScript, listScripts } from "./tools/script";
import { addMotionRig } from "./tools/rig";
import { addPuppet } from "./tools/puppet";
import { addLight } from "./tools/light";
import { setMaterial } from "./tools/material";
import { optimizeTextures } from "./tools/optimize";
import { createEffect } from "./tools/neweffect";
import { createParticles } from "./tools/newparticles";
import { findExamples, copyExampleLayer, EXAMPLE_FEATURES } from "./tools/examples";
import { listMonitors } from "./tools/monitors";
import { backupTool, restoreProject } from "./tools/backup";
import { previewScene, inspectImage, convertTexture, unpackPackage, validateProject, ToolOutput } from "./tools/preview";
import { API_REFERENCE, sceneGuide, effectsCookbook } from "./docs";

const INSTRUCTIONS = `Wallpaper Engine MCP. Prefer SCENE wallpapers (editable in the Wallpaper Engine editor) over web wallpapers.
Read resource we://scene-guide first. Rules that matter:
- All positions are canvas pixels, origin TOP-LEFT, y DOWN. x/y place the layer's anchor (default center). get_scene prints every layer in the same units.
- Build back-to-front: create_scene_wallpaper -> add_layer -> preview_scene (grid:true) -> add_effect (+masks) -> animate_layer -> validate_project -> apply_wallpaper.
- Effects need masks to affect only part of a layer (create_mask / masks argument, canvas-pixel shapes). Verify with preview_scene masks_of.
- preview_scene shows layout only (no effects/particles/animation). To SEE the real result (effects, particles, motion) call capture_wallpaper {project, frames:4}: it opens a pop-out window (the user's desktop wallpaper is not replaced) and returns a filmstrip; crop zooms into a detail; cursor/click/properties test mouse scripts, click effects and switches/sliders. Do this after every effect/animation change. validate_project ends with a performance estimate (VRAM, effect load).
- Depth and life: add_light (point/spot/tube/directional), add_script templates audio (music), media (now playing, album colour), event (animation events), emit (particle bursts); add_layer frames/sprite (animated image) or video (mp4). Learn from installed wallpapers with find_examples / copy_example_layer (clones a layer with its effects, masks, scripts and files). list_monitors shows what each monitor runs.
- Smooth, switchable motion: add_script (SceneScript templates wobble/cursor/lag/gain/scene/click) instead of keyframes; bind each one to a user-property switch + slider so the viewer can turn every movement on/off (see we://scene-guide "Scripts and options"). add_motion_rig builds a whole character's lean/sway/breath/head chain with scripts and options in one call. add_puppet gives a picture layer a skeleton (puppet warp: tail, hair, ears, arms bend smoothly; optional bone physics and attachment points that other layers ride on), you pick the bones in canvas px. backup_project before big changes.
- Look and feel: set_material (normal map = relief for lights, metallic/roughness/emissive masks, reflection), add_light volumetrics (visible beam), optimize_textures (DXT = a quarter of the video memory), create_effect (your own GLSL effect), create_particles (a particle system from scratch: emitters, initializers, operators, control points, child systems), create_video_wallpaper (an mp4 project), add_script templates daytime/hover/toggle/launch. SceneScript API typings: resource we://scenescript-api.
- Rotation is degrees counter-clockwise. add_text size is the font size in canvas px and (x,y) is the left/centre/right anchor of the text (align).`;

// one version, in package.json (dist/index.js sits one level below it)
const server = new McpServer({ name: "wallpaper-engine", version: require("../package.json").version }, { instructions: INSTRUCTIONS });

type Out = string | ToolOutput;

/** Register a tool: errors become readable tool errors, images are returned as MCP image content. */
function reg(name: string, description: string, shape: z.ZodRawShape, fn: (a: any) => Promise<Out> | Out): void {
  server.tool(name, description, shape, async (args: any) => {
    try {
      const r = await fn(args);
      if (typeof r === "string") return { content: [{ type: "text" as const, text: r }] };
      return {
        content: [
          { type: "text" as const, text: r.text },
          ...(r.images ?? []).map(i => ({ type: "image" as const, data: i.data.toString("base64"), mimeType: i.mime })),
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e?.message ?? e}` }], isError: true };
    }
  });
}

/* ---------------- shared schemas ---------------- */

const Ref = z.union([z.string(), z.number()]);
const LayerRef = Ref.describe("Layer: numeric id or name (get_scene lists both)");
const Led = z.boolean().optional().describe("RGB hardware (Corsair iCUE, Razer Chroma): only THIS layer drives the LEDs instead of the whole picture. Use ONE layer, small (a 32x32 solid + tint/pulse is enough), inside the visible area, anywhere in the z-order");
const TexProp = z.string().optional().describe('Key of a new "texture" user property bound to this image layer: the viewer picks their own image/video in the properties panel (the layer\'s picture is the default and sets the size/aspect - keep it at the aspect of the expected images). Plain image layers only.');
const Project = z.string().describe("Project folder name (as in list_wallpapers) or absolute path");
const Place = z
  .union([z.enum(["top", "bottom"]), z.number().int(), z.object({ above: Ref }), z.object({ below: Ref })])
  .describe('z-order: "top" (default), "bottom", an index, {above: layer} or {below: layer}');
const Prop = z
  .object({
    property: z.string().describe("user property key"),
    label: z.string().optional().describe("label in the Wallpaper Engine properties panel"),
    type: z.enum(["bool", "slider", "color", "combo", "textinput", "group", "text", "texture", "usershortcut"]).optional().describe("group = collapsible section header, text = plain label (both via update_properties add_properties); texture = the viewer picks an image/video (bind it with add_layer/update_layer texture_property); usershortcut = the viewer picks an application a script launches with engine.openUserShortcut(key)"),
    show_if: z.string().optional().describe("key of a bool property: show this control only while it is on (hides the sliders of a disabled option)"),
    min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
    options: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) })).optional(),
    value: z.any().optional().describe("default value"),
    condition: z.union([z.string(), z.number()]).optional().describe("combo + `visible` only: visible while the combo equals this option value, e.g. a style selector shared by several layers"),
  })
  .describe("User-adjustable property: instead of a fixed value pass {property, label, type, value}; it appears in the WE properties panel");
const Num = z.union([z.number(), Prop]);
const Bool = z.union([z.boolean(), Prop]);
const Col = z.union([z.string(), z.array(z.number()), Prop]).describe('"#rrggbb", "r g b" (0-1), [r,g,b] or a user property');
const Vec2 = z.union([z.number(), z.array(z.number())]);

const Shape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rect"), x: z.number(), y: z.number(), w: z.number(), h: z.number(), radius: z.number().optional(), rotation: z.number().optional(), value: z.number().min(0).max(1).optional(), feather: z.number().min(0).optional() }),
  z.object({ type: z.literal("ellipse"), cx: z.number(), cy: z.number(), rx: z.number(), ry: z.number().optional(), rotation: z.number().optional(), value: z.number().min(0).max(1).optional(), feather: z.number().min(0).optional() }),
  z.object({ type: z.literal("polygon"), points: z.array(z.array(z.number())).min(3), value: z.number().min(0).max(1).optional(), feather: z.number().min(0).optional() }),
  z.object({ type: z.literal("path"), d: z.string().describe("SVG path data"), value: z.number().min(0).max(1).optional(), feather: z.number().min(0).optional() }),
  z.object({ type: z.literal("gradient"), from: z.array(z.number()), to: z.array(z.number()), from_value: z.number().optional(), to_value: z.number().optional() }),
  z.object({ type: z.literal("radial"), cx: z.number(), cy: z.number(), r: z.number(), inner: z.number().min(0).max(0.99).optional().describe("fraction of r that stays fully on"), value: z.number().min(0).max(1).optional() }),
]);
const MaskBase = {
  color: z.object({ color: z.union([z.string(), z.array(z.number())]), tolerance: z.number().min(0).max(1).optional(), softness: z.number().min(0).max(1).optional() }).optional().describe('colour key on the source pixels (the `image`, else the layer texture): on where the pixel colour is within tolerance (default 0.15) of `color`, fading out over softness (default 0.1); transparent pixels never match. Example: pick the hair of a figure with {color:"#e8832a", tolerance:0.2}'),
  threshold: z.number().min(0).max(1).optional().describe("binarise the source level (colour key, from_layer, image): on at or above this level"),
  grow: z.number().optional().describe("after the shapes: grow (+) or shrink (-) the active area by N mask px (hard edge)"),
  falloff: z.number().min(0).optional().describe("after grow: fade out smoothly over N mask px beyond the edge of the active area (exact distance, unlike blur): glow / aura masks around a silhouette"),
  shapes: z.array(Shape).optional().describe("Shapes painted in order (white = effect on). Coordinates are canvas px unless space:'layer'"),
  from_layer: z.boolean().optional().describe("use the layer's own silhouette (alpha) as the mask"),
  image: z.string().optional().describe("absolute path of a painted image (white = on) or an existing 'masks/<name>'"),
  base: z.number().min(0).max(1).optional().describe("starting level under the shapes (default 0 = effect off)"),
  invert: z.boolean().optional(),
  blur: z.number().optional().describe("blur radius in mask px"),
  channel: z.enum(["luma", "alpha"]).optional().describe("which channel of `image` to use"),
  space: z.enum(["canvas", "layer"]).optional().describe("coordinate space of shapes: canvas px (default) or layer texture px"),
  resolution: z.number().optional().describe("max side of the mask in px (default 2048)"),
};
const MaskBody = {
  ...MaskBase,
  combine: z.array(z.object({ op: z.enum(["add", "subtract", "intersect"]), ...MaskBase })).optional().describe("merge more masks in at the same size, in order (add = union, subtract = remove, intersect = overlap), before blur/invert. Example: the figure minus its hair: {from_layer:true, combine:[{op:'subtract', color:{color:'#e8832a'}}]}"),
};
const MaskInline = z.object({ ...MaskBody, name: z.string().optional() });
const Mask = z.union([z.string(), MaskInline]).describe("existing mask 'masks/<name>', an image path, or an inline mask spec (shapes / from_layer / image)");
const Masks = z
  .object({ opacity: Mask.optional(), flow: Mask.optional(), timeoffset: Mask.optional() })
  .describe("Masks per effect slot: opacity (where it applies), flow (direction map), timeoffset (phase offsets). See list_effects for the slots of an effect");

const FxBody = {
  values: z.record(z.string(), z.any()).optional().describe('Effect parameters by key, e.g. {"strength":0.1,"speed":1.5,"direction":"45deg"}. Values may be {property,...} user-property bindings'),
  combos: z.record(z.string(), z.any()).optional().describe('Shader combos, e.g. {"AUDIOPROCESSING":1,"DIRECTION":"left"}'),
  masks: Masks.optional(),
  textures: z.record(z.string(), z.string()).optional().describe("Raw texture slot overrides: slot number -> texture ref (e.g. util/noise)"),
  name: z.string().optional().describe("Label shown in the editor effect list"),
  visible: Bool.optional(),
};

/* ====================================================================
   Web wallpaper / project tools
   ==================================================================== */

reg("list_wallpapers", "List installed wallpapers by category (myprojects, default, workshop, or all)", { category: z.enum(["myprojects", "default", "workshop", "all"]).optional() }, ({ category }) => listWallpapers(category));

reg("get_wallpaper_info", "Get detailed info about a wallpaper project: project.json contents and full file tree", { name: z.string().describe("Folder name or absolute path of the wallpaper project") }, ({ name }) => getWallpaperInfo(name));

reg(
  "create_wallpaper",
  `Create a new WEB wallpaper project (HTML/JS) from a template. Templates: ${TEMPLATE_NAMES.join(", ")}. Web wallpapers show only as a file list in the WE editor - for anything layered/editable use create_scene_wallpaper instead.`,
  {
    name: z.string().optional().describe("Folder name (auto-slugified)"),
    title: z.string().optional().describe("Display title in Wallpaper Engine"),
    description: z.string().optional().describe("Description"),
    template: z.enum(TEMPLATE_NAMES as [string, ...string[]]).optional().describe("Starter template (default: blank)"),
  },
  ({ name, title, description, template }) => createWallpaper(name, title, description, template),
);

reg("read_wallpaper_file", "Read a text file from a wallpaper project (HTML, CSS, JS, JSON, etc.)", { project: Project, file: z.string().describe("Relative file path, e.g. index.html or scene.json") }, ({ project, file }) => readWallpaperFile(project, file));

reg("write_wallpaper_file", "Write or update a text file in a wallpaper project (creates subdirs as needed). For scenes prefer the dedicated scene tools; use this for scripts, shaders, particle JSON.", { project: Project, file: z.string().describe("Relative file path, e.g. script.js"), content: z.string().describe("File content") }, ({ project, file, content }) => writeWallpaperFile(project, file, content));

reg(
  "import_image",
  "Copy any asset file (PNG, JPG, GIF, WebM, audio, fonts...) from disk into a wallpaper project as-is. For scene layers use add_layer instead (it converts to .tex).",
  { project: Project, source_path: z.string().describe("Absolute path to the source file on disk"), dest_path: z.string().optional().describe("Destination relative path inside project (default: same filename)") },
  ({ project, source_path, dest_path }) => importImage(project, source_path, dest_path),
);

reg(
  "apply_wallpaper",
  "Apply a wallpaper to a monitor (or a floating window) via the Wallpaper Engine command line. Starts Wallpaper Engine if it is not running. Re-apply after every change: files are reloaded from disk.",
  {
    project: Project,
    monitor: z.number().optional().describe("Monitor index, 0 = first (default 0)"),
    window: z.object({ name: z.string().optional(), width: z.number().optional(), height: z.number().optional(), x: z.number().optional(), y: z.number().optional(), borderless: z.boolean().optional() }).optional().describe("Open in a window instead of the desktop"),
    preset: z.string().optional().describe("Name of a saved local preset of the wallpaper"),
  },
  (a) => applyWallpaper(a),
);

reg(
  "capture_wallpaper",
  'SEE what Wallpaper Engine really renders (effects, particles, post-process, animation). With `project` it opens the wallpaper in a pop-out window (the desktop wallpaper is NOT replaced), waits for it to load and captures that window; without `project` it captures an already open pop-out window. frames:4 (+ interval_ms) returns a filmstrip so you can judge motion such as sway, waves and particles. cursor / click / properties test the interactive parts: mouse-follow scripts, click effects, and every user switch/slider. Windows only; the window may stay behind other windows. Use it after every effect/animation change instead of guessing.',
  {
    project: Project.optional().describe("wallpaper to open in the pop-out window first (omit to capture the window as it is)"),
    window: z.string().optional().describe('pop-out window title (default "mcp_preview")'),
    width: z.number().optional().describe("window width when opening (default 1280)"), height: z.number().optional().describe("window height when opening (default 720)"),
    wait_ms: z.number().optional().describe("load time to wait after opening (default 4500)"),
    frames: z.number().int().min(1).max(8).optional().describe("number of captures (default 1); >1 = filmstrip"),
    interval_ms: z.number().optional().describe("pause between frames (default 500; 0 = as fast as the capture allows). The filmstrip labels show the real capture times"),
    output_width: z.number().optional().describe("width of the returned image (default 1280)"),
    crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("zoom into a detail (hair, blade...) as fractions 0..1 of the window, e.g. {x:0.4,y:0.1,w:0.3,h:0.4}"),
    cursor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional().describe("move the REAL mouse here (fractions of the window, y down) before the first frame to test cursor/mouse-follow scripts; it is put back afterwards"),
    click: z.boolean().optional().describe("press the left button at `cursor` (window centre if omitted) right before the first frame: tests click effects such as sparks. Refused if another window covers that spot"),
    properties: z.record(z.string(), z.unknown()).optional().describe('user property values for this capture only (needs `project`), e.g. {"rain":true,"hair_amount":2}: shows each switch/slider of the wallpaper without editing it (project.json is restored)'),
  },
  (a) => captureWallpaper(a),
);

reg(
  "control_wallpaper",
  "Control Wallpaper Engine: pause/stop/play, mute/unmute, next/close wallpaper, open a saved playlist or profile, hide/show desktop icons, get the current wallpaper path, or change user properties live (apply_properties, e.g. {\"rain\":true,\"schemecolor\":\"1 0 0\"}).",
  {
    action: z.enum(["pause", "stop", "play", "mute", "unmute", "next", "close", "open_playlist", "open_profile", "apply_properties", "hide_icons", "show_icons", "get_wallpaper"]),
    monitor: z.number().optional().describe("Monitor index for next/close/open_playlist/apply_properties/get_wallpaper (default: all/first)"),
    playlist: z.string().optional().describe("Playlist name (open_playlist)"),
    profile: z.string().optional().describe("Profile name (open_profile)"),
    properties: z.record(z.string(), z.unknown()).optional().describe("Property key -> value (apply_properties)"),
  },
  (a) => controlWallpaper(a),
);

reg(
  "update_properties",
  "Edit project.json: add typed user properties (add_properties), raw properties, metadata (title, description, preview...) and general flags such as supportsaudioprocessing. Properties are also created automatically when you pass {property:...} bindings to scene tools.",
  {
    project: Project,
    add_properties: z.array(Prop).optional().describe('Typed user properties: [{property:"rain",label:"Rain",type:"bool",value:true}]'),
    set_properties: z.record(z.string(), z.unknown()).optional().describe('Raw property objects by key, e.g. {"speed": {"type":"slider","text":"Speed","min":0.1,"max":5,"value":1}}'),
    remove_properties: z.array(z.string()).optional().describe("Property keys to remove"),
    set_metadata: z.record(z.string(), z.unknown()).optional().describe('Top-level project.json fields, e.g. {"title":"New","description":"...","tags":["Anime"]}'),
    set_general: z.record(z.string(), z.unknown()).optional().describe('Fields of project.json "general" other than properties, e.g. {"supportsaudioprocessing": true}'),
  },
  ({ project, add_properties, set_properties, remove_properties, set_metadata, set_general }) => updateProperties(project, set_properties, remove_properties, set_metadata, set_general, add_properties),
);

reg("delete_wallpaper", "Delete a wallpaper project from myprojects (cannot delete default or workshop wallpapers)", { project: z.string().describe("Project folder name to delete") }, ({ project }) => deleteWallpaper(project));

reg("delete_wallpaper_file", "Delete a single file from a wallpaper project in myprojects", { project: Project, file: z.string().describe("Relative file path to delete") }, ({ project, file }) => deleteWallpaperFile(project, file));

/* ====================================================================
   Scene: project + layers
   ==================================================================== */

reg(
  "create_scene_wallpaper",
  "Create an editable SCENE wallpaper (what the WE editor makes). Optionally with a background image, which is converted to .tex automatically - no editor step needed. Canvas default 1920x1080. Then use add_layer / add_effect / animate_layer. Read resource we://scene-guide for coordinates and workflow.",
  {
    name: z.string().describe("Project folder name (auto-slugified)"),
    title: z.string().optional().describe("Display title (default: name)"),
    description: z.string().optional(),
    image: z.string().optional().describe("Absolute path of the background image"),
    width: z.number().optional().describe("Canvas width px (default 1920; 2560/3840 for sharper)"),
    height: z.number().optional().describe("Canvas height px (default 1080)"),
    fit: z.enum(["cover", "contain", "stretch"]).optional().describe("How the background fills the canvas (default cover)"),
    background_color: z.string().optional().describe('Clear colour behind all layers, e.g. "#000000"'),
  },
  (a) => createSceneWallpaper(a),
);

reg(
  "create_video_wallpaper",
  "Create a plain VIDEO wallpaper from an mp4 (like dropping a video on the editor's Create Wallpaper): just project.json + the file, no layers. Want effects, particles, lights or switches on the video? Use create_scene_wallpaper + add_layer {video} instead.",
  {
    name: z.string().describe("Project folder name (auto-slugified)"),
    video: z.string().describe("Absolute path of the video (mp4 recommended; the Workshop accepts only mp4)"),
    title: z.string().optional(), description: z.string().optional(),
    preview: z.string().optional().describe("Absolute path of an image for the thumbnail (default: dark placeholder)"),
    tags: z.array(z.string()).optional().describe('e.g. ["Anime", "Nature"]'),
  },
  (a) => createVideoWallpaper(a),
);

reg(
  "get_scene",
  "Describe a scene: canvas size, scene settings, user properties and every layer (bottom -> top, grouped by parent) with id, kind, centre, natural and on-screen size, bounding box, scale, rotation, alpha, blend, effects (#index, mask marks), animations. All coordinates are canvas px from the TOP-LEFT - the same units add_layer/update_layer take.",
  { project: Project },
  ({ project }) => getScene(project),
);

reg(
  "add_layer",
  "Add an image layer (converted to .tex automatically); give frames (several images) or sprite (a sprite sheet) for an ANIMATED texture, or video (an .mp4) for a VIDEO layer. Position with x,y = canvas px from the TOP-LEFT of the point given by `anchor` (default center); size with width/height (px on screen), scale or fit. Example: standing figure on a floor line: {image, x:1400, y:980, anchor:'bottom', height:900}. Layers are added on top unless `position` says otherwise. Check with preview_scene.",
  {
    project: Project,
    image: z.string().optional().describe("Absolute path of a PNG/JPG/WebP (use transparent PNG for cut-outs); with sprite = a sprite sheet. Omit when passing frames"),
    frames: z.array(z.string()).min(2).optional().describe("ANIMATED layer from several same-size images (absolute paths, in order): a flame, a walk cycle, a logo; they become one sprite sheet. Set the speed with sprite.fps"),
    sprite: z.object({ cols: z.number().int().min(1).optional(), rows: z.number().int().min(1).optional(), count: z.number().int().min(1).optional(), fps: z.number().positive().optional() }).optional().describe("animated texture: for a sprite SHEET (image) give cols x rows (frames across and down, reading order) and optionally count of frames used; fps = playback speed (default 12). The layer is as big as ONE frame"),
    video: z.string().optional().describe("VIDEO layer: absolute path of an .mp4 (copied into the project; plays looped, effects and masks work on it; the layer is as big as the video; its codec must play on the viewer's Windows)"),
    name: z.string().optional(),
    x: z.number().optional().describe("canvas px, 0 = left edge (default: canvas centre)"),
    y: z.number().optional().describe("canvas px, 0 = TOP edge, grows downward (default: canvas centre)"),
    anchor: z.enum(["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]).optional().describe("which point of the layer lands on (x,y); scale/rotation also pivot there"),
    width: z.number().optional().describe("on-screen width px (aspect kept if height omitted)"),
    height: z.number().optional().describe("on-screen height px (aspect kept if width omitted)"),
    scale: Vec2.optional().describe("multiplier of the natural size (number or [sx,sy]); ignored if width/height/fit given"),
    fit: z.enum(["cover", "contain", "stretch"]).optional().describe("scale to the canvas"),
    rotation: z.number().optional().describe("degrees, counter-clockwise"),
    alpha: Num.optional().describe("0..1 or a user property"),
    color: Col.optional().describe("tint multiplied with the image"),
    brightness: Num.optional(),
    blend: z.string().optional().describe("normal (default), add, screen, multiply, overlay, soft-light, hard-light, color-dodge, difference, ... (additive for glows)"),
    parallax_depth: Vec2.optional().describe("0 = static .. 1 = strongest parallax (needs scene_settings parallax.enabled)"),
    parent: LayerRef.optional().describe("attach to a group/layer (world position is kept)"),
    visible: Bool.optional().describe("false, or a user property to let the user toggle it"),
    position: Place.optional(),
    locked: z.boolean().optional().describe("lock transforms in the editor"),
    tile: z.boolean().optional().describe("texture REPEATS at the edges instead of clamping: required for the scroll effect (speed lines, fog, clouds); the image must be seamless"),
    led: Led,
    texture_property: TexProp,
  },
  ({ project, ...o }) => addLayer(project, o as any),
);

reg(
  "update_layer",
  "Change a layer. Position: x/y put the anchor at an absolute canvas px (TOP-LEFT origin), dx/dy nudge relative (dy>0 = down). Size: width/height, scale, scale_by. rotation (absolute) / rotate_by (relative), degrees CCW. Scale and rotation act about the anchor (default center). Also alpha, color, brightness, blend, parallax_depth, visible, name, parent (null = unparent), move_to (z-order), raw (any scene.json field).",
  {
    project: Project, layer: LayerRef,
    name: z.string().optional(),
    x: z.number().optional(), y: z.number().optional(),
    anchor: z.enum(["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]).optional(),
    dx: z.number().optional(), dy: z.number().optional(),
    width: z.number().optional(), height: z.number().optional(),
    scale: Vec2.optional(), scale_by: z.number().optional(),
    rotation: z.number().optional(), rotate_by: z.number().optional(),
    alpha: Num.optional(), color: Col.optional(), brightness: Num.optional(), blend: z.string().optional(),
    parallax_depth: Vec2.optional(), visible: Bool.optional(), locked: z.boolean().optional(),
    parent: z.union([Ref, z.null()]).optional(), move_to: Place.optional(),
    raw: z.record(z.string(), z.any()).optional().describe("Set raw scene.json fields on the layer (advanced)"),
    lighting: z.boolean().optional().describe("image layers: receive the scene's lights (add_light) or not"),
    led: Led,
    texture_property: TexProp,
  },
  ({ project, layer, ...u }) => updateLayer(project, layer, u as any),
);

reg(
  "remove_layer",
  "Remove a layer (and by default its children). Texture files stay in the project folder.",
  { project: Project, layer: LayerRef, with_children: z.boolean().optional().describe("default true; false keeps children in place") },
  ({ project, layer, with_children }) => removeLayer(project, layer, with_children ?? true),
);

reg(
  "duplicate_layer",
  "Duplicate a layer with its effects, animations and children (new ids), placed just above the original; optional px offset. Handy for glow layers (duplicate -> blend:'add' -> scale_by) and repeated elements.",
  { project: Project, layer: LayerRef, name: z.string().optional(), dx: z.number().optional(), dy: z.number().optional() },
  ({ project, layer, ...a }) => duplicateLayer(project, layer, a),
);

reg(
  "add_group",
  "Add an empty group (invisible pivot/transform). x,y = pivot in canvas px (TOP-LEFT origin). Attach layers via `children` or update_layer parent, then rotate/scale/animate the group to move everything about that pivot. (animate_layer sway/breathe creates these automatically.)",
  { project: Project, name: z.string(), x: z.number().optional(), y: z.number().optional(), rotation: z.number().optional(), scale: z.number().optional(), parent: LayerRef.optional(), children: z.array(LayerRef).optional(), position: Place.optional() },
  ({ project, ...a }) => addGroup(project, a as any),
);

const Anchor = z.enum(["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]);
const UtilShape = {
  project: Project, name: z.string().optional(),
  x: z.number().optional().describe("canvas px, 0 = left edge (default: canvas centre)"),
  y: z.number().optional().describe("canvas px, 0 = TOP edge, grows downward (default: canvas centre)"),
  anchor: Anchor.optional().describe("which point of the rectangle lands on (x,y)"),
  width: z.number().optional().describe("px (default: whole canvas)"), height: z.number().optional().describe("px (default: whole canvas)"),
  parent: LayerRef.optional(), visible: Bool.optional().describe("false, or a user property so the viewer can toggle it"), position: Place.optional(),
  led: Led,
};

reg(
  "add_solid_layer",
  "Add a flat colour rectangle (whole canvas and black by default). Uses: dim or tint everything below (alpha 0.2-0.5, or blend multiply/overlay), a background colour (position:'bottom'), vignettes and soft shadows (add_effect opacity with a radial/gradient mask), light washes (blend add/screen).",
  { ...UtilShape, color: Col.optional().describe('default "#000000"'), alpha: Num.optional(), rotation: z.number().optional(), blend: z.string().optional() },
  ({ project, ...a }) => addUtilLayer(project, { ...a, kind: "solid" } as any),
);

reg(
  "add_effect_layer",
  "Add a POST-PROCESS layer: effects added to it with add_effect are applied to everything BELOW it in the z-order (e.g. godrays, shine, tint, chromaticaberration, filmgrain, vhs, localcontrast, blur, fisheye, or installed Workshop ones such as cutout_vignette; scene-wide bloom is scene_settings bloom). kind 'fullscreen' (default) covers the whole canvas; 'area' restricts it to a rectangle (x, y, width, height). Default position is the top; keep layers that must stay untouched (text, UI) above it.",
  { ...UtilShape, kind: z.enum(["fullscreen", "area"]).optional() },
  ({ project, kind, ...a }) => addUtilLayer(project, { ...a, kind: kind === "area" ? "compose" : "fullscreen" } as any),
);

reg(
  "add_text",
  "Add a text layer, or a live clock/date/day-of-week (dynamic) with a built-in script. (x,y) in canvas px (TOP-LEFT origin) is the ANCHOR of the text: its centre for align:center (default), its left edge for align:left, its right edge for align:right; the line is vertically centred on y. WE sizes the text box itself. Colour can be a user property so the viewer can recolour it.",
  {
    project: Project, text: z.string().optional().describe("static text (\\n for lines)"), dynamic: z.enum(["clock", "date", "day"]).optional(),
    name: z.string().optional(), x: z.number().optional(), y: z.number().optional(),
    size: z.number().optional().describe("font size in CANVAS PIXELS (the em; capital letters are ~0.72 of it, e.g. 120 = a 86 px tall headline). Default 64. Converted to WE's pointsize (px / 4.1667) - do not pass points."),
    color: Col.optional(), font: z.string().optional().describe("systemfont_arial (default), systemfont_<name>, or a project font path"),
    align: z.enum(["left", "center", "right"]).optional(), padding: z.number().optional().describe("px around the text inside the box (default 32)"),
    max_width: z.number().optional().describe("wrap long text at this width (px)"), alpha: Num.optional(), rotation: z.number().optional(),
    parent: LayerRef.optional(), position: Place.optional(), visible: Bool.optional(),
  },
  ({ project, ...a }) => addText(project, a as any),
);

reg(
  "add_sound",
  "Add a looping/random sound layer; the audio file is copied into the project (sounds/). volume can be a user property.",
  { project: Project, file: z.string().describe("Absolute path of an audio file (mp3/wav/ogg)"), name: z.string().optional(), volume: Num.optional().describe("0..1 (default 0.5)"), mode: z.enum(["loop", "random"]).optional(), min_time: z.number().optional(), max_time: z.number().optional() },
  ({ project, ...a }) => addSound(project, a as any),
);

reg(
  "scene_settings",
  "Typed scene-level settings: clear colour, bloom, camera parallax (mouse depth), camera shake, HDR, ambient/skylight, zoom. For anything else use modify_scene.",
  {
    project: Project,
    clear_color: Col.optional(),
    bloom: z.object({
      enabled: z.boolean().optional(), strength: z.number().optional(), threshold: z.number().optional(), tint: z.string().optional(),
      hdr: z.object({ strength: z.number().optional(), scatter: z.number().optional(), threshold: z.number().optional(), smoothing: z.number().optional(), iterations: z.number().int().optional() }).optional()
        .describe("HDR bloom (also set top-level hdr:true): glow only around parts brighter than the screen can show (layer brightness > 1, bright particles). Defaults strength 2, scatter 1.6, threshold 1 (keep near 1), smoothing 0.1 (0 = hard edge, 1 = even dark parts glow a little). Only viewers with post-processing 'Ultra' see it; they see the plain bloom otherwise, so set both"),
    }).optional().describe("typical: strength 1-2, threshold 0.6-0.9. Bloom glows bright areas of ALL layers; if only the source image should glow, paint the glow into the image"),
    parallax: z.object({ enabled: z.boolean().optional(), amount: z.number().optional(), delay: z.number().optional(), mouse_influence: z.number().optional() }).optional().describe("typical: amount 0.5-1, delay 0.1; layers need parallax_depth"),
    camera_shake: z.object({ enabled: z.boolean().optional(), amplitude: z.number().optional(), roughness: z.number().optional(), speed: z.number().optional() }).optional(),
    hdr: z.boolean().optional(), ambient_color: z.string().optional(), skylight_color: z.string().optional(), zoom: z.number().optional(), camera_fade: z.boolean().optional(),
  },
  ({ project, ...s }) => sceneSettings(project, s as any),
);

reg(
  "modify_scene",
  "Low-level: set raw scene.json general keys and raw keys on objects by array index (prefer the typed tools; get_scene shows ids, not indexes).",
  {
    project: Project,
    general_settings: z.record(z.string(), z.unknown()).optional().describe('e.g. {"bloom": true, "bloomstrength": 2.0}'),
    object_updates: z.array(z.object({ index: z.number(), properties: z.record(z.string(), z.unknown()) })).optional().describe('e.g. [{"index":0,"properties":{"scale":"1.1 1.1 1.1"}}]'),
  },
  ({ project, general_settings, object_updates }) => modifyScene(project, general_settings, object_updates),
);

/* ====================================================================
   Effects, masks, animation, particles
   ==================================================================== */

reg(
  "list_effects",
  'Browse effects. No args: all built-in effects by group with their main parameter keys + installed Workshop effects. query filters. {effect:"shake"} prints every parameter key (default, range), mask slots and combos plus a usage tip. Workshop effects: "workshop/<itemId>/<name>" (installed into the project automatically on add_effect).',
  { query: z.string().optional(), effect: z.string().optional().describe('effect name for full details, e.g. "waterwaves"'), source: z.enum(["builtin", "workshop", "all"]).optional(), project: z.string().optional().describe("needed to describe project-local effects") },
  (a) => listEffectsTool(a),
);

reg(
  "add_effect",
  'Add an effect to a layer (image, text, group, solid layer or post-process layer). An effect only changes the layer it sits on: to grade/blur/glow the WHOLE picture, add it to an add_effect_layer layer instead. Parameters by their real keys (call list_effects effect:"<name>" first), validated against the shader; unknown keys are rejected with the valid list; colours accept "#rrggbb". Use `masks` to limit it to a region: masks:{opacity:{shapes:[{type:"polygon",points:[[x,y],...],feather:20}]}} (canvas px). Effects run in order (#0 first). Example: {layer:"hero", effect:"shake", values:{strength:0.08,speed:1.2}, masks:{opacity:{shapes:[{type:"ellipse",cx:960,cy:300,rx:120,ry:90,feather:30}]}}}.',
  { project: Project, layer: LayerRef, effect: z.string().describe('effect name ("shake"), project-local, or "workshop/<id>/<name>"'), ...FxBody, position: z.union([z.enum(["start", "end"]), z.number().int()]).optional().describe("index in the layer's effect stack (default end)") },
  ({ project, layer, effect, ...o }) => addEffect(project, layer, effect, o as any),
);

reg(
  "update_effect",
  "Change an existing effect on a layer: parameters, combos, masks, name, visibility or stack position. effect = index (#n from get_scene), effect name or custom label. Only the keys you pass change.",
  { project: Project, layer: LayerRef, effect: Ref.describe("effect index (#n), name, or label"), ...FxBody, move_to: z.number().int().optional() },
  ({ project, layer, effect, ...o }) => updateEffect(project, layer, effect, o as any),
);

reg("remove_effect", "Remove an effect from a layer (index #n from get_scene, effect name or label).", { project: Project, layer: LayerRef, effect: Ref }, ({ project, layer, effect }) => removeEffect(project, layer, effect));

reg(
  "create_mask",
  "Create a reusable greyscale mask (white = effect on) from shapes, the layer's silhouette, a colour key of the layer/image (color), or an image, and write it to the project (masks/<name>). Refine it without any image editor: threshold, grow/shrink, falloff (soft glow around the area), combine (add / subtract / intersect other masks), blur, invert. Order: source -> threshold -> shapes -> grow -> falloff -> combine -> blur -> invert. Shape coordinates are canvas px (TOP-LEFT origin, the same you read from preview_scene) unless space:'layer'. Then pass masks:{opacity:'masks/<name>'} to add_effect. Verify with preview_scene masks_of.",
  { project: Project, name: z.string().describe("mask name"), layer: LayerRef.optional().describe("layer the mask is mapped onto (needed for canvas-space shapes and from_layer)"), ...MaskBody },
  ({ project, ...a }) => createMask(project, a as any),
);

reg(
  "animate_layer",
  `Animate a layer property (origin, angles, scale, alpha, color, brightness) or an effect parameter (effect + param) with keyframes. Easiest: preset (${Object.keys(ANIM_PRESETS).join(", ")}) and override amplitude/period. origin amplitude = [dx,dy] px (y down), angles = degrees (CCW +), scale = delta, alpha/brightness = +- around the current value. sway/breathe pivot about the layer base via an automatic group (pivot:"center" or {x,y} px to change). Values are offsets around the static pose, so place the layer first. Vary period/phase between layers for natural motion. clear:true removes an animation.`,
  {
    project: Project, layer: LayerRef,
    preset: z.enum(Object.keys(ANIM_PRESETS) as [string, ...string[]]).optional(),
    property: z.enum(["origin", "angles", "scale", "alpha", "color", "brightness"]).optional(),
    effect: Ref.optional().describe("animate an effect parameter instead: effect index/name"), param: z.string().optional().describe("effect parameter key"),
    wave: z.enum(["sine", "triangle", "pulse", "noise", "ramp"]).optional().describe("sine/triangle loop, pulse = flash + decay, noise = random flicker, ramp = from->to"),
    amplitude: Vec2.optional().describe("peak value per axis (number or array)"), period: z.number().optional().describe("seconds per cycle (ramp: duration)"),
    phase: Vec2.optional().describe("start offset as fraction of the cycle (0..1), per axis"),
    from: Vec2.optional(), to: Vec2.optional(), mode: z.enum(["loop", "mirror", "single"]).optional(),
    pivot: z.union([z.string(), z.object({ x: z.number(), y: z.number() })]).optional().describe("pivot for angles/scale: anchor name (bottom, top, center, ...) or {x,y} canvas px"),
    keyframes: z.array(z.object({ t: z.number().describe("seconds"), value: Vec2 })).optional().describe("custom keyframes instead of a wave"),
    events: z.array(z.object({ t: z.number().describe("seconds into the cycle"), name: z.string() })).optional().describe("named moments of the cycle, handled by add_script template event on the same layer (show a layer, emit particles, play a sound at exact times; amplitude 0 makes a pure timer)"),
    clear: z.boolean().optional(),
    linear: z.boolean().optional().describe("constant speed between keyframes (no ease in/out): a cloud or a belt crossing the screen; combine with mode loop and from/to or keyframes"),
    name: z.string().optional().describe("name of the animation, for scripts: thisLayer.getAnimation(name).play() / pause() / setFrame(n)"),
    start_paused: z.boolean().optional().describe("the animation waits until a script plays it"),
    wrap_loop: z.boolean().optional().describe("Wallpaper Engine closes the loop smoothly itself (custom keyframes; the waves are already closed)"),
    join: z.enum(["origin", "angles", "scale", "alpha", "color", "brightness"]).optional().describe("put this property on the SAME timeline as the layer's existing animation of that property (same length and speed; e.g. a light fading in and out while it moves): animate the first one, then call again with join"),
  },
  ({ project, layer, ...a }) => animateLayer(project, layer, a as any),
);

reg(
  "add_script",
  "Attach a SceneScript to a layer property (origin, angles, scale, alpha, brightness, visible, text, color, light intensity / radius) or to an effect parameter (effect + param): CONTINUOUS behaviour instead of keyframes (smooth noise, breathing, mouse follow, spring follow-through, gusts/pulses/beats, MUSIC reaction, animation events, now-playing text / album colour, particle bursts) whose switches and sliders become user properties the viewer can toggle: bind:{enabled:{property:'hair_on',label:'Hair motion'}, amount:{property:'hair_amount',label:'Hair intensity',min:0,max:2,show_if:'hair_on'}}. Templates: wobble, cursor, lag, gain (alpha/params), scene, click (mouse-press particles on a transparent top layer's visible), audio (react to the music: pulse a light / scale / alpha), event (animation events -> show layers / bursts / sounds), media (now-playing text, album colour), emit (periodic particle bursts), daytime (fade a layer / light / particles by the local hour: night overlay, lit windows), hover (cursor over the layer), toggle (click shows / hides layers, remembered across restarts), launch (click opens an app the viewer picks) (list:true explains them; or pass code + props). Particle systems: property count / rate / size / speed / lifetime / alpha drive the emitter multipliers. pivot works like animate_layer for angles/scale. Full SceneScript API: resource we://scenescript-api (use it for custom code). Not shown by preview_scene - use capture_wallpaper.",
  {
    project: Project, layer: LayerRef.optional(), list: z.boolean().optional().describe("just list the templates"),
    template: z.enum(["wobble", "cursor", "lag", "gain", "scene", "click", "audio", "event", "media", "emit", "daytime", "hover", "toggle", "launch"]).optional(),
    code: z.string().optional().describe("custom SceneScript source (instead of a template)"),
    props: z.array(z.object({ name: z.string(), label: z.string().optional(), kind: z.enum(["checkbox", "slider"]).optional(), value: z.union([z.number(), z.boolean()]), min: z.number().optional(), max: z.number().optional() })).optional().describe("script properties declared by custom code"),
    property: z.enum(["origin", "angles", "scale", "alpha", "brightness", "visible", "intensity", "radius", "text", "color", "count", "rate", "size", "speed", "lifetime"]).optional().describe("intensity / radius = of a light layer (add_light); text / color for the media template; count / rate / size / speed / lifetime (and alpha / brightness) of a PARTICLE layer = its emitter multipliers"),
    effect: Ref.optional(), param: z.string().optional(),
    pivot: z.union([z.string(), z.object({ x: z.number(), y: z.number() })]).optional(),
    amplitude: Vec2.optional().describe("wobble/cursor: px [x,y] (origin), degrees (angles), scale delta [x,y]"),
    period: z.number().optional(), seed: z.number().optional(), shape: z.enum(["noise", "sine", "breath", "none", "beat", "burst"]).optional(),
    targets: z.union([z.string(), z.array(z.string())]).optional().describe("click: hidden particle layers shown at the cursor on a press (taken in turns)"), duration: z.number().optional().describe("click: seconds each layer stays visible (default 0.4)"),
    what: z.enum(["parallax", "bloom", "shake"]).optional().describe("scene template: which scene setting the switch controls"), base: z.number().optional().describe("scene template: strength at amount 1"),
    variation: z.number().optional().describe("gain: modulation depth 0..1"), off: z.number().optional().describe("gain: value when disabled (default 0)"), hold: z.boolean().optional().describe("gain: when disabled keep base x amount (only the modulation stops)"), root: z.boolean().optional().describe("gain: use sqrt(amount) - waterwaves reach grows with strength squared"),
    band: z.union([z.enum(["bass", "mid", "treble", "all"]), z.array(z.number()).length(2)]).optional().describe("audio: spectrum band, or [firstBin, lastBin] of 16"), sensitivity: z.number().optional().describe("audio: initial sensitivity slider (default 1)"), attack: z.number().optional().describe("audio: rise speed /s (default 25); smooth = decay /s"), min: z.number().optional().describe("audio on numbers: base x min in silence (default 0.4)"), max: z.number().optional().describe("audio on numbers: base x max at full level (default 1.6)"),
    on: z.string().optional().describe("event: only this event name"), emit: z.union([z.string(), z.array(z.string())]).optional().describe("event: particle layers to burst"), sounds: z.union([z.string(), z.array(z.string())]).optional().describe("event: sound layers to play"), count: z.number().optional().describe("event / emit: particles per burst"), jitter: z.number().optional().describe("emit: random variation of the period 0..1"),
    format: z.string().optional().describe("media text: {artist} {title} {album}"), fallback: z.string().optional().describe("media text: shown when nothing plays"), which: z.enum(["primary", "secondary", "tertiary", "text"]).optional().describe("media colour: which album colour"),
    hours: z.array(z.number()).length(2).optional().describe("daytime: [from, to] hours 0-24 where the value is on (default [18, 6] = night; may wrap midnight)"), fade: z.number().optional().describe("daytime: fade length in hours (default 1)"),
    rest: z.number().optional().describe("hover: multiplier while the cursor is away (default 0.6)"), hover: z.number().optional().describe("hover: multiplier while the cursor is over the layer (default 1)"),
    key: z.string().optional().describe("toggle: localStorage key (default toggle_<layer id>)"), start: z.boolean().optional().describe("toggle: targets shown on the very first run (default true)"),
    shortcut: z.string().optional().describe("launch: key of the usershortcut property (default shortcut1)"), label: z.string().optional().describe("launch: label of that property (default Application)"),
    publish: z.string().optional().describe("wobble: share the offsets under this name"), from: z.string().optional().describe("lag: published name to follow"),
    component: z.number().optional(), gain: z.number().optional(), smooth: z.number().optional(), damping: z.number().optional(), invert: z.boolean().optional(),
    bind: z.record(z.string(), z.union([Prop, z.number(), z.boolean()])).optional().describe("script property name (enabled, amount, speed) -> user property or fixed value"),
    clear: z.boolean().optional().describe("remove the script"),
  },
  ({ project, layer, list, ...a }) => {
    if (list) return listScripts();
    if (layer === undefined) throw new Error("layer is required (or list:true).");
    return addScript(project, layer, a as any);
  },
);

const Pt = z.object({ x: z.number(), y: z.number() });
reg(
  "add_light",
  "Add a real-time LIGHT (point, spot, tube or directional) that shades the image layers: glow of a lamp or fire, a spotlight on the hero, a neon tube, moonlight from one side. x,y = canvas px (TOP-LEFT origin), height = how far above the wallpaper, radius = reach in px, intensity ~1 subtle .. 10 strong (100 = blown out). Spot / directional: aim:{x,y} = the point they shine at (default straight down), cone degrees. Tube: to:{x,y} = the other end. The image layers get the LIGHTING flag on their material (lit: 'all' by default, a list, or 'none'); the picture is then shaded by the scene ambient light (default 0.3 = darker) plus the lights, so raise ambient (or scene_settings) when the scene becomes too dark. intensity / color / radius / visible can be {property,...} user options and intensity accepts add_script (gain flicker, audio). Not drawn by preview_scene: use capture_wallpaper.",
  {
    project: Project, type: z.enum(["point", "spot", "tube", "directional"]).optional(), name: z.string().optional(),
    x: z.number().optional().describe("canvas px, 0 = left edge (default: centre)"), y: z.number().optional().describe("canvas px, 0 = TOP edge (default: centre)"),
    height: z.number().optional().describe("px above the wallpaper (default point 100, spot 300, tube 60, directional 300)"),
    color: Col.optional(), intensity: Num.optional(), radius: Num.optional().describe("reach in px (default point 600, spot 1000, tube 150)"),
    aim: Pt.optional().describe("spot / directional: canvas point it shines at"), cone: z.object({ inner: z.number().optional(), outer: z.number().optional() }).optional().describe("spot cone angles in degrees (default 25 / 45)"),
    to: Pt.optional().describe("tube: other end (default 400 px to the right)"),
    lit: z.union([z.enum(["all", "none"]), z.array(LayerRef)]).optional().describe('image layers that receive the light (default "all")'),
    ambient: z.union([z.number(), z.string()]).optional().describe("scene ambient light 0..1 or a colour (default scene: 0.3)"),
    volumetrics: z.union([z.boolean(), z.object({ density: z.number().optional().describe("default 2; lower (0.5-1) for a thin beam, 3+ washes the picture out"), exponent: z.number().optional() })]).optional().describe("visible light beam in the air (god rays / fog cone), best on spot lights"),
    visible: Bool.optional().describe("false, or a user property so the viewer can switch the light"), position: Place.optional(),
  },
  ({ project, ...a }) => addLight(project, a as any),
);

reg(
  "set_material",
  'Surface of an image layer for lights and reflections: a NORMAL MAP (relief that lights rake across: normal_map "auto" derives it from the picture - bright = raised - or pass an image path), PBR masks (metallic_map / roughness_map / reflection_map / emissive_map: grayscale images), constants (roughness 0..1, metallic 0..1, specular_tint, emissive {color,brightness}) and REFLECTION (reflection:true mirrors what is drawn BELOW the layer, bent by the normal map: water, glass, polished floor; reflectivity 0..1). Reflection is SUBTLE on gentle normals: it needs steep relief (normal_strength 40-100 on a soft picture) and metallic ~1 (which brightens it); verified live: a bright disc above a rippled glass mirrors in it. Lights only shade layers with lighting (add_light does that); reflection works without lights. clear:true removes it all. Not drawn by preview_scene: use capture_wallpaper.',
  {
    project: Project, layer: LayerRef,
    normal_map: z.string().optional().describe('"auto" (relief from the picture) or an absolute image path'),
    normal_strength: z.number().optional().describe("auto relief depth (default 3; 1 gentle, 6 deep)"), normal_blur: z.number().optional().describe("auto relief smoothing in px (default 1.5, 0 = sharp pixels)"),
    flip_y: z.boolean().optional().describe("flip the normal map green axis if the light seems to come from the wrong side vertically"),
    metallic_map: z.string().optional(), roughness_map: z.string().optional(), reflection_map: z.string().optional(), emissive_map: z.string().optional(),
    roughness: z.number().optional(), metallic: z.number().optional(), specular_tint: z.string().optional(),
    emissive: z.object({ color: z.string().optional(), brightness: z.number().optional().describe("0..10, only used where emissive_map is bright") }).optional(),
    reflection: z.boolean().optional(), reflectivity: z.number().optional(), reflectivity_distance: z.number().optional().describe("how far the reflection is bent (default 4)"),
    clear: z.boolean().optional(),
  },
  ({ project, layer, ...a }) => setMaterial(project, layer, a as any),
);

reg(
  "optimize_textures",
  "Shrink the video memory of a scene: re-encodes the plain RGBA8888 pictures of image layers as DXT5 (with transparency) or DXT1 (fully opaque) = a quarter of the memory for a slight loss (some banding on smooth gradients, so do not use it on big soft skies or on tiny UI). Sizes are padded to multiples of 16 (the editor's own DXT pads to powers of two: 1920x1080 -> 2048x2048). Sprite sheets, videos, already compressed textures and WE's own assets are skipped; the original .png stays next to the .tex. Run backup_project first, then validate_project (performance estimate) and capture_wallpaper to check the look.",
  {
    project: Project, layer: LayerRef.optional().describe("only this layer (default: every image layer of at least min_size)"),
    format: z.enum(["auto", "dxt5", "dxt1"]).optional().describe("auto (default) = dxt1 when fully opaque, dxt5 otherwise"),
    min_size: z.number().optional().describe("skip pictures smaller than min_size x min_size px (default 256)"),
  },
  ({ project, ...a }) => optimizeTextures(project, a as any),
);

reg(
  "create_effect",
  'Write a NEW image effect (custom shader) into a project, like the editor\'s Add Effect > New: effects/<name>/effect.json + materials + shaders/effects/<name>.frag/.vert, then use it with add_effect {effect:"<name>"} (values, masks, bindings, animation all work: the opacity mask is built in). You only write the GLSL BODY in `code`: it runs on `albedo` (vec4, the layer pixel; assign to change it), with `uv` (vec2), `original` (the untouched pixel), `mask` (0..1; the result is blended with `original` by it), `g_Time` (seconds), `g_Texture0` (the layer, sample it again at another uv to distort) and one `u_<key>` uniform per entry of `params` (float slider with range, vec2, vec3, color). WE GLSL: texSample2D(), CAST3(x), frac(), mul(), atan2(), saturate(); from common.h hsv2rgb, rgb2hsv, rotateVec2, greyscale, M_PI. Example, the official desaturation: params [{key:"amount", default:1, range:[0,1]}], code "albedo.rgb = mix(albedo.rgb, CAST3(dot(vec3(0.11,0.59,0.3), albedo.rgb)), u_amount);". `helpers` = functions / extra uniforms (g_PointerPosition, g_TexelSize...) before main; `frag` = a whole fragment shader. Same name again rewrites the shader. Single pass only. A shader that fails to compile shows no effect: verify with capture_wallpaper.',
  {
    project: Project, name: z.string().describe("lower-case letters, digits, _ (also the folder / file name)"), title: z.string().optional().describe("name in the editor's effect list"),
    params: z.array(z.object({
      key: z.string().describe("lower-case; uniform u_<key> and the key in add_effect values"), type: z.enum(["float", "vec2", "vec3", "color"]).optional().describe("default float"), label: z.string().optional(),
      default: z.union([z.number(), z.string(), z.array(z.number())]).optional().describe('number, "x y" / [x,y] or a colour "#rrggbb"'), range: z.tuple([z.number(), z.number()]).optional().describe("float slider min/max (default 0..max(1, 2 x default))"),
    })).optional(),
    code: z.string().optional().describe("GLSL statements, see the description (empty = pass-through)"), helpers: z.string().optional(), frag: z.string().optional(),
  },
  ({ project, ...a }) => createEffect(project, a as any),
);

reg(
  "add_motion_rig",
  "Give a figure life in ONE call: a chain of pivot groups with continuous scripts and options. Body: lean toward the mouse > idle sway > breathing (children = `body` layers, pivot = body_pivot, default the canvas bottom-centre: it leans about its feet). Optional head chain (`head` layers + `head_pivot` = the neck): head tilt/nod that lags behind the sway > head look > head aim, hanging under the body chain so it follows the body. Every movement gets a switch + amount slider in the properties panel (<name>_look, _sway, _breath, _head and *_amt) plus a shared 'Animate everything' switch and 'Animation speed' slider. World positions do not change. Typical use: duplicate the figure layer, clip the copy to the head with an opacity mask, then pass the figure as body and the copy as head. Check with capture_wallpaper (cursor:{x,y} tests the lean).",
  {
    project: Project, body: z.array(LayerRef).min(1).describe("layers that move with the whole figure"), body_pivot: Pt.optional().describe("canvas px; default bottom-centre of the canvas"),
    head: z.array(LayerRef).optional().describe("head layers (needs head_pivot)"), head_pivot: Pt.optional().describe("the neck, canvas px"),
    motions: z.array(z.enum(["lean", "sway", "breath", "head"])).optional().describe("default all: lean = follows the mouse, sway = idle sway, breath = breathing, head = idle head tilt/nod"),
    name: z.string().optional().describe('prefix of the groups and of the property keys (default "rig")'), master: z.boolean().optional().describe("shared master switch + speed slider (default true)"),
  },
  ({ project, ...a }) => addMotionRig(project, a as any),
);

reg(
  "add_puppet",
  "PUPPET WARP without the editor: turn a picture layer into a skinned puppet whose parts bend smoothly (tail, hair, ears, arms, a whole body). You give the SKELETON: `bones` = joints in canvas px (TOP-LEFT origin, y down), each with a unique name and an optional `parent` (an earlier bone; omitted = root), e.g. a tail {bones:[{name:'t1',x:900,y:700},{name:'t2',x:950,y:760,parent:'t1'},{name:'t3',x:1000,y:840,parent:'t2'}]}. The tool builds the mesh from the picture's opaque pixels (a grid, `detail` cells along the longer side, default 40), skins every vertex to its two nearest bones (distance to the bone segment, 1/d^2), writes models/<x>_mcp_puppet.mdl and repoints the layer. A bone rotates about its joint and carries its children; the last bone of a chain points away from its parent. Motion = ONE script on the layer's alpha that sets the local bone angles (SceneScript thisLayer.setLocalBoneAngles, radians): idle `sway` (degrees per bone, default 3, children trail their parent by `lag` seconds, one `period` s) and optional `lean` (degrees toward the mouse at the screen edge, per bone; sign is automatic), each with a switch + amount slider in the properties panel (<name>_sway, <name>_lean, *_amt) and the shared 'Animate everything' / 'Animation speed'. Per-bone `sway: 0` keeps a bone rigid. Put bones at joints and keep a rigid part near its own bone. `physics` (true or {mode:'spring'|'rigid', stiffness, friction, inertia, mass, gravity, limit}) turns on Wallpaper Engine's own bone physics for every bone with a parent: they follow the movement of their parent with inertia (hair, tail, rope, cape), so keep `sway` on the ROOT bone and the rest trails it by itself (a physics bone has no sway of its own unless given); `gravity:true` + mode rigid makes a chain hang down; no switch for it; per-bone `physics:false` keeps a bone out. `attach` = points on the skeleton that other layers ride on: [{name, x, y, bone?(default nearest), layers:[layer refs]}] - the listed layers keep their place and follow that bone (an earring, a hair clip, a hand-held item, a rigid body part of a character made of separate PNGs). Run it again on the same layer with other bones to redo it (list the riders again). Not covered: MDLA keyframe clips (scripts do the motion), IK, blend shapes, one mesh from several part PNGs. Not drawn by preview_scene - judge with capture_wallpaper.",
  {
    project: Project, layer: LayerRef.describe("the picture layer to deform"),
    bones: z.array(z.object({
      name: z.string(), x: z.number().describe("joint, canvas px from the left"), y: z.number().describe("joint, canvas px from the TOP"), parent: z.string().optional().describe("an earlier bone; omitted = root"),
      sway: z.number().optional().describe("idle sway degrees of this bone (0 = rigid)"), lean: z.number().optional().describe("degrees toward the mouse at the screen edge"),
      physics: z.boolean().optional().describe("simulate this bone (default: every bone with a parent when `physics` is set)"),
    })).min(1),
    physics: z.union([z.boolean(), z.object({
      mode: z.enum(["spring", "rigid"]).optional().describe("spring returns to the rest pose (default); rigid keeps the last pose and drags"),
      stiffness: z.number().optional().describe("spring pull back (default 300)"), friction: z.number().optional().describe("damping, higher = calmer (default 12)"),
      inertia: z.number().optional().describe("higher = reacts less to the parent's movement (default 30)"), mass: z.number().optional().describe("tip mass, higher = gravity wins (default 20)"),
      gravity: z.boolean().optional().describe("pull the bones down (default false)"), limit: z.number().optional().describe("max bend each way in degrees (default 60)"),
    })]).optional().describe("bone physics on every bone with a parent: they trail the root's movement with inertia"),
    attach: z.array(z.object({
      name: z.string(), x: z.number().describe("canvas px from the left"), y: z.number().describe("canvas px from the TOP"), bone: z.string().optional().describe("bone it rides on (default the nearest)"),
      layers: z.array(LayerRef).optional().describe("layers that keep their place and follow this point from now on"),
    })).optional().describe("points other layers can be parented to (they follow the bone)"),
    detail: z.number().optional().describe("mesh cells along the longer side (default 40; 8..200)"), name: z.string().optional().describe("label / property key prefix (default the layer name)"),
    sway: z.number().optional().describe("default idle sway degrees per bone (default 3; 0 = none)"), lean: z.number().optional().describe("default lean degrees toward the mouse (default 0 = off)"),
    period: z.number().optional().describe("seconds of one idle cycle (default 6)"), lag: z.number().optional().describe("seconds each bone trails its parent (default 0.35)"),
    master: z.boolean().optional().describe("shared master switch + speed slider (default true)"),
  },
  ({ project, ...a }) => addPuppet(project, a as any),
);

reg(
  "backup_project",
  "Copy a project of myprojects to projects/mcp_backups/<project>/<timestamp> (outside myprojects, so Wallpaper Engine does not list the copies). Do this before a big restructuring: the scene tools edit files in place. delete_wallpaper keeps a copy by itself.",
  { project: Project, note: z.string().optional().describe("short label added to the backup id") },
  ({ project, note }) => backupTool(project, note),
);

reg(
  "restore_project",
  'Without `backup`: list the backups of a project. With backup:"<id>" or "latest": put that backup back into myprojects (also re-creates a deleted project). The current state is backed up first, so a restore can be undone too.',
  { project: z.string().describe("project folder name"), backup: z.string().optional().describe('backup id from the list, or "latest"') },
  ({ project, backup }) => restoreProject(project, backup),
);

reg("list_particles", "List particle/light presets shipped with Wallpaper Engine (rain, snow, embers, sparks, fog, stars, lightning, magic, fireworks, bubbles, leaves, light shafts, ...).", { query: z.string().optional() }, ({ query }) => listParticles(query));

reg(
  "add_particles",
  'Add a preset particle system or light-shaft quad. preset "<category>/<name>" (list_particles). x,y = emitter origin in canvas px (TOP-LEFT origin); scale grows the emission area. Multipliers (1 = preset): count, rate, size, speed, lifetime, alpha, brightness; color tints - each can be a {property,label,...} user property (a "Snow amount" slider, a "Flame colour" picker) and add_script property count/rate/size/speed/lifetime/alpha drives them live (audio, hover, time of day). Example: {preset:"ember/ember", x:960, y:1000, scale:3, count:1.5, color:"#ff8844"}. Particles are not drawn by preview_scene.',
  {
    project: Project, preset: z.string(), name: z.string().optional(), x: z.number().optional(), y: z.number().optional(), scale: Vec2.optional(), rotation: z.number().optional(),
    parent: LayerRef.optional(), position: Place.optional(), visible: Bool.optional(), parallax_depth: Vec2.optional(),
    count: Num.optional(), rate: Num.optional(), size: Num.optional(), speed: Num.optional(), lifetime: Num.optional(), alpha: Num.optional(), brightness: Num.optional(), color: Col.optional().describe("tint; a user property lets the viewer pick the colour"),
    file: z.string().optional().describe("another particle file of the preset, e.g. preset spark/spark file sparktrails = a spark burst (list the names by passing a wrong one)"),
    patch: z.record(z.string(), z.any()).optional().describe("edit the particle itself (merged into a project copy): objects by key, arrays by index with null = keep. Example: {emitter:[{rate:200,instantaneous:0,speedmax:900}], initializer:[{min:0.1,max:0.5},{min:4,max:9}], operator:[{gravity:\"0 -1800 0\"}]}"),
  },
  ({ project, ...a }) => addParticles(project, a as any),
);

const Comp = z.object({ name: z.string() }).passthrough();
const CpSpec = z.object({ pointer: z.boolean().optional(), offset: z.union([Vec2, z.string(), z.array(z.number())]).optional(), worldspace: z.boolean().optional(), parent: z.number().optional() });
const ParticleBody = {
  texture: z.string().optional().describe('stock "particle/halo" (default), "particle/shape/star_4", "particle/smoke/smoke1"..., a project texture or an absolute image path'),
  blending: z.enum(["additive", "translucent", "normal"]).optional().describe("additive (default: light, sparks), translucent, normal"),
  maxcount: z.number().optional().describe("max live particles (default 500): as low as the effect allows"), starttime: z.number().optional().describe("seconds pre-simulated at start, so it does not begin empty"), flags: z.number().optional(),
  emitter: z.array(Comp).optional(), initializer: z.array(Comp).optional(), operator: z.array(Comp).optional(), renderer: z.array(Comp).optional(),
  control_points: z.record(z.string(), CpSpec).optional().describe('keys "1".."7" (0 is the system origin): {"1":{pointer:true}} locks point 1 to the mouse; components use it with controlpoint:1'),
};

reg(
  "create_particles",
  'Build a particle system FROM SCRATCH (not a preset) and place it: writes particles/<name>.json + material and adds the layer (x, y, scale, rotation, parent, visible, count/rate/size/speed/lifetime/alpha/brightness/color as in add_particles). Components are WE\'s own: {name, ...keys}; vectors as [x,y,z] or "x y z"; colours "#rrggbb". An empty category gets a sensible default. EMITTERS sphererandom | boxrandom {rate /s, instantaneous N (burst; rate 0 + instantaneous = one shot), origin, directions "1 1 0", distancemin, distancemax, speedmin/max, duration, delay, controlpoint}, layerimage. INITIALIZERS (per particle, random between min and max, optional exponent): lifetimerandom (s) | sizerandom (px) | colorrandom (colours) | alpharandom | velocityrandom ("x y z" px/s) | rotationrandom | angularvelocityrandom | turbulentvelocityrandom {scale, timescale, speedmin/max, phasemin/max, forward} | positionoffsetrandom | hsvcolorrandom | colorlist | inheritcontrolpointvelocity | mapsequencearoundcontrolpoint {count, controlpoint} (ring) | mapsequencebetweencontrolpoints {count, controlpointstart, controlpointend} (line) | remapinitialvalue | inheritinitialvaluefromevent (child takes the parent\'s colour/size). OPERATORS: movement {gravity "0 -100 0", drag} (WITHOUT IT NOTHING MOVES) | alphafade {fadeintime, fadeouttime = fractions of life} | sizechange / colorchange / alphachange {startvalue, endvalue, starttime, endtime = fractions of life} | oscillatealpha / oscillateposition / oscillatesize {frequencymin/max, scalemin/max, phasemin/max} | turbulence {scale, speedmin/max, timescale, mask} | vortex {speedinner/outer, distanceinner/outer, controlpoint} | controlpointattract {controlpoint, scale (NEGATIVE pushes away), threshold = reach px, origin} | reducemovementnearcontrolpoint | maintaindistancetocontrolpoint | maintaindistancebetweencontrolpoints | capvelocity {maxspeed} | angularmovement {force} | collisionplane / collisionbounds / collisionsphere / collisionquad {collisionbehavior bounce|slide|stop|delete} | boids | remapvalue. RENDERERS sprite (default) | spritetrail {length, maxlength} | rope | ropetrail. MOUSE: control_points {"1":{pointer:true}} + operator {name:"controlpointattract", controlpoint:1, scale:-5000, threshold:300} = particles flee the cursor. CHILDREN: [{type: static | eventfollow (follow each particle) | eventspawn | eventdeath (burst where a particle dies), system: {same fields as here; texture and blending default to the parent\'s} or file: "particles/x.json", maxcount, probability 0..1, origin/angles/scale, set_control_points: N}]: a firework = parent with few big fast particles + an eventdeath child with instantaneous 150. Example: {name:"embers", x:960, y:1000, texture:"particle/halo", maxcount:300, emitter:[{name:"boxrandom", rate:60, distancemax:[900,20,0]}], initializer:[{name:"lifetimerandom",min:3,max:6},{name:"sizerandom",min:8,max:24},{name:"velocityrandom",min:[-20,40,0],max:[20,160,0]},{name:"colorrandom",min:"#ff8800",max:"#ffdd44"}], operator:[{name:"movement"},{name:"alphafade",fadeintime:0.2,fadeouttime:0.6},{name:"turbulence",scale:0.01,speedmin:20,speedmax:60}]}. Not drawn by preview_scene: use capture_wallpaper (cursor tests control points).',
  {
    project: Project, name: z.string().describe("lower-case letters, digits, _ (names the files and the layer)"),
    ...ParticleBody,
    children: z.array(z.object({
      type: z.enum(["static", "eventfollow", "eventspawn", "eventdeath"]).optional(), file: z.string().optional(),
      system: z.object({ ...ParticleBody, children: z.array(z.any()).optional() }).optional().describe("inline child system"),
      maxcount: z.number().optional(), probability: z.number().optional(), origin: Vec2.optional(), angles: z.array(z.number()).optional(), scale: z.array(z.number()).optional(), set_control_points: z.number().optional().describe("copy this system's particle positions into the child's control points from this index (1..7)"),
    })).optional(),
    x: z.number().optional(), y: z.number().optional(), scale: Vec2.optional(), rotation: z.number().optional(), parent: LayerRef.optional(), position: Place.optional(), visible: Bool.optional(), parallax_depth: Vec2.optional(),
    count: Num.optional(), rate: Num.optional(), size: Num.optional(), speed: Num.optional(), lifetime: Num.optional(), alpha: Num.optional(), brightness: Num.optional(), color: Col.optional(),
  },
  ({ project, ...a }) => createParticles(project, a as any),
);

/* ====================================================================
   Seeing, checking, converting
   ==================================================================== */

reg(
  "preview_scene",
  "Render the scene layout to an image you can SEE: image/text layers with position, scale, rotation, alpha, tint and blend, plus dashed boxes with ids/names. grid:true overlays labelled canvas-px gridlines (cyan x, yellow y); region:{x,y,w,h} zooms into details; masks_of:[layers] tints effect masks red; only:[layers] isolates layers; save_thumbnail writes preview.jpg. Solid layers and the opacity effect (alpha x mask) are drawn; other effects, post-process layers, particles and animation are NOT simulated - apply_wallpaper to judge motion.",
  {
    project: Project,
    region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("canvas px region to zoom into"),
    width: z.number().optional().describe("output width px (default 1280, 1024 for regions)"),
    grid: z.union([z.boolean(), z.number()]).optional().describe("true = automatic step, or a step in canvas px"),
    labels: z.boolean().optional().describe("draw layer boxes + ids (default true)"),
    only: z.array(LayerRef).optional(), masks_of: z.array(LayerRef).optional(), save_thumbnail: z.boolean().optional(),
  },
  (a) => previewScene(a),
);

reg(
  "inspect_image",
  "Look at an image (png/jpg/webp/.tex) or a layer's texture with a labelled grid in SOURCE pixels, and get its size, visible bounding box and centroid. Use it before placing a cut-out (to size/anchor it) and to read pixel coordinates for masks with space:'layer'. region zooms into part of the image.",
  { path: z.string().optional().describe("absolute image path"), project: z.string().optional(), layer: LayerRef.optional(), region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("source px"), width: z.number().optional(), grid: z.number().optional().describe("grid step in source px") },
  (a) => inspectImage(a),
);

reg("validate_project", "Check a scene project for problems before applying: missing models/textures/masks/effects/sounds, duplicate ids, bad parents, undefined user properties, effect pass mismatches, oversized textures, off-canvas layers. Also a performance estimate from the WE docs: texture memory (vs the 300/500 MB guideline) with the biggest textures and the DXT5 saving, textures larger than they are shown, non-official canvas resolution, effect load (full-canvas passes) and script/particle counts.", { project: Project }, ({ project }) => validateProject(project));

reg(
  "convert_texture",
  "Convert a .tex to PNG, or an image to .tex (RGBA with mips; mask:true = single-channel R8). add_layer already does this automatically; use this for manual workflows.",
  { input: z.string().describe("absolute path (.tex or image)"), output: z.string().optional(), mask: z.boolean().optional() },
  (a) => convertTexture(a),
);

reg(
  "unpack_pkg",
  "Unpack a scene .pkg (Workshop item id, project name or absolute path) to a folder to study how good wallpapers are built (scene.json, effects, masks, particles, .mdl puppets). decode_textures also writes PNGs next to the .tex files.",
  { source: z.string().describe("Workshop item id, project name, folder or .pkg path"), output: z.string().optional(), filter: z.string().optional().describe("regex on file names, e.g. '\\\\.json$'"), decode_textures: z.boolean().optional() },
  (a) => unpackPackage(a),
);

reg(
  "list_monitors",
  "List the displays (Windows names, size, position, primary) and which wallpaper each Wallpaper Engine monitor (Monitor0, Monitor1, ...) currently shows, with the viewer's saved settings for it. Use the index with control_wallpaper monitor:N. Read-only; playlists / profiles are opened by name with control_wallpaper (creating them is not possible from outside the editor).",
  {},
  () => listMonitors(),
);

reg(
  "find_examples",
  `Search the INSTALLED scene wallpapers (Workshop, default, mine) to learn how pros did something: by effect (e.g. effect:'waterwaves'), feature (${EXAMPLE_FEATURES.join(", ")}) and / or title or Workshop id. Lists layers, the effects used and the features of each. Then inspect one with copy_example_layer.`,
  { query: z.string().optional().describe("part of the title, or the exact Workshop id"), effect: z.string().optional().describe("part of an effect name, e.g. shine, waterwaves, cloudmotion"), feature: z.enum(EXAMPLE_FEATURES as [string, ...string[]]).optional(), limit: z.number().optional().describe("default 20") },
  (a) => findExamples(a),
);

reg(
  "copy_example_layer",
  "Study or reuse a layer of an installed scene wallpaper. source = Workshop id / folder name / exact title. Without layer: the whole layer tree, scene settings and user properties. With layer (id or name): that layer and its children with effect parameter values and script sources. With project too: COPY it (children, effects, masks, scripts, models, materials, textures, particles, shaders, sounds) into your project; user-property bindings become fixed values, scene settings (bloom, parallax) are not copied; refused when your project already has different files at the same paths. x / y place the copy (canvas px).",
  { source: z.string(), layer: LayerRef.optional(), project: Project.optional(), name: z.string().optional().describe("name of the copy"), x: z.number().optional(), y: z.number().optional() },
  (a) => copyExampleLayer(a),
);

/* ====================================================================
   Resources
   ==================================================================== */

const res = (name: string, uri: string, text: () => string) =>
  server.resource(name, uri, { mimeType: "text/markdown" }, async () => ({ contents: [{ uri, text: text(), mimeType: "text/markdown" }] }));

res("scene-guide", "we://scene-guide", sceneGuide);
res("effects-cookbook", "we://effects-cookbook", effectsCookbook);
res("api-reference", "we://api-reference", () => API_REFERENCE);
// the official SceneScript typings (every class, event and method) ship with Wallpaper Engine's editor
res("scenescript-api", "we://scenescript-api", () => {
  const f = path.join(WE_PATH, "ui", "dist", "monaco", "autocomplete", "lib.sceneScript.d.ts");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : `Not found: ${f} (Wallpaper Engine's editor typings).`;
});

/* ---------------- start ---------------- */

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
