import * as fs from "fs";
import * as path from "path";
import { BUILTIN_EFFECTS, forgetEffect, loadEffect, describeEffect } from "../effects";
import { colorStr, openScene } from "../sceneio";

export interface EffectParam {
  key: string; type?: "float" | "vec2" | "vec3" | "color"; label?: string;
  default?: number | string | number[]; range?: [number, number];
}
export interface EffectArgs {
  name: string; title?: string; params?: EffectParam[];
  /** GLSL statements run on `albedo` (vec4, the layer pixel); also `uv`, `original`, `mask` (0..1), `g_Time` and one `u_<key>` uniform per param */
  code?: string;
  /** declarations / functions placed before main(): helpers, extra uniforms (g_PointerPosition, g_TexelSize...) */
  helpers?: string;
  /** a complete fragment shader instead of the generated one (uniform annotations are still read for the controls) */
  frag?: string;
}

// WE's own tint.vert: passes uv in xy and the opacity-mask uv in zw
const VERT = `uniform mat4 g_ModelViewProjectionMatrix;

#if MASK
uniform vec4 g_Texture1Resolution;
#endif

attribute vec3 a_Position;
attribute vec2 a_TexCoord;

varying vec4 v_TexCoord;

void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_TexCoord = a_TexCoord.xyxy;

#if MASK
	v_TexCoord.zw = vec2(v_TexCoord.x * g_Texture1Resolution.z / g_Texture1Resolution.x,
						v_TexCoord.y * g_Texture1Resolution.w / g_Texture1Resolution.y);
#endif
}
`;

const GLSL = { float: "float", vec2: "vec2", vec3: "vec3", color: "vec3" } as const;
const ZERO = { float: 1, vec2: "0 0", vec3: "0 0 0", color: "1 1 1" } as const;

/** `uniform <type> u_<key>; // {annotation}`: the line the editor reads to draw the slider / colour picker */
function paramLine(p: EffectParam): string {
  const type = p.type ?? "float";
  if (!/^[a-z][a-z0-9_]*$/.test(p.key)) throw new Error(`Parameter key "${p.key}": lower-case letters, digits and _ only (it becomes u_${p.key} and the key in add_effect values).`);
  if (!GLSL[type]) throw new Error(`Parameter "${p.key}": type must be float, vec2, vec3 or color.`);
  const d = p.default ?? ZERO[type];
  const ann: any = { material: p.key, label: p.label ?? p.key.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) };
  if (type === "color") { ann.type = "color"; ann.default = colorStr(d as any); }
  else if (type === "float") { ann.default = Number(d); if (!Number.isFinite(ann.default)) throw new Error(`Parameter "${p.key}": default must be a number.`); }
  else ann.default = Array.isArray(d) ? d.join(" ") : String(d);
  if (p.range) { if (type !== "float" || !(p.range[0] < p.range[1])) throw new Error(`Parameter "${p.key}": range [min, max] needs min < max and a float.`); ann.range = p.range; }
  else if (type === "float") ann.range = [0, Math.max(1, Math.ceil(Math.abs(ann.default) * 2))];
  return `uniform ${GLSL[type]} u_${p.key}; // ${JSON.stringify(ann)}`;
}

function fragOf(a: EffectArgs): string {
  if (a.frag) return a.frag;
  return `#include "common.h"

varying vec4 v_TexCoord;

uniform sampler2D g_Texture0; // {"hidden":true}
uniform sampler2D g_Texture1; // {"label":"ui_editor_properties_opacity_mask","mode":"opacitymask","combo":"MASK","paintdefaultcolor":"0 0 0 1"}

uniform float g_Time;
${(a.params ?? []).map(paramLine).join("\n")}
${a.helpers ?? ""}

void main() {
	vec2 uv = v_TexCoord.xy;
	vec4 albedo = texSample2D(g_Texture0, uv);
	vec4 original = albedo;
	float mask = 1.0;
#if MASK
	mask = texSample2D(g_Texture1, v_TexCoord.zw).r;
#endif
${(a.code ?? "").split(/\r?\n/).map(l => "\t" + l).join("\n")}
	gl_FragColor = mix(original, albedo, mask);
}
`;
}

/**
 * New project-local effect (what the editor's "Add Effect > New" writes): effects/<name>/effect.json, materials/effects/<name>.json,
 * shaders/effects/<name>.frag + .vert. Calling it again with the same name rewrites the shader of an effect made here.
 */
export function createEffect(project: string, a: EffectArgs): string {
  const { dir } = openScene(project);
  if (!/^[a-z][a-z0-9_]*$/.test(a.name)) throw new Error(`Effect name "${a.name}": lower-case letters, digits and _ only.`);
  if (fs.existsSync(path.join(BUILTIN_EFFECTS, a.name, "effect.json"))) throw new Error(`"${a.name}" is a built-in effect name: pick another.`);
  const ej = path.join(dir, "effects", a.name, "effect.json");
  if (fs.existsSync(ej) && JSON.parse(fs.readFileSync(ej, "utf8")).editable !== true) throw new Error(`effects/${a.name} exists and was not made by create_effect: pick another name.`);
  const files = { frag: `shaders/effects/${a.name}.frag`, vert: `shaders/effects/${a.name}.vert`, mat: `materials/effects/${a.name}.json` };
  const frag = fragOf(a);                       // may throw on a bad param: nothing is written yet
  const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put(files.frag, frag);
  put(files.vert, VERT);
  put(files.mat, JSON.stringify({ passes: [{ blending: "normal", cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled", shader: `effects/${a.name}` }] }, null, "\t"));
  put(`effects/${a.name}/effect.json`, JSON.stringify({
    dependencies: [files.mat, files.frag, files.vert], editable: true, group: "localeffects", name: a.title ?? a.name.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()),
    passes: [{ material: files.mat }], replacementkey: a.name, version: 1,
  }, null, "\t"));
  forgetEffect(ej);
  const info = loadEffect(a.name, dir);
  return [
    `Effect "${a.name}" written to the project (${files.frag}, ${files.vert}, ${files.mat}, effects/${a.name}/effect.json).`,
    info ? describeEffect(info) : "Could not read it back: check the uniform annotations.",
    `Use it: add_effect {layer, effect:"${a.name}", values:{...}}; masks work (the opacity mask is built in). Shader errors only show in the editor or as a missing effect: check with capture_wallpaper.`,
    "Layers that already use it keep their stored values: after changing the params remove_effect + add_effect again.",
  ].join("\n");
}
