import { Obj, openScene, saveScene, findLayer, bindProperty, isPropSpec, PropSpec, kindOf, nextId } from "../sceneio";
import { matchParam } from "../effects";
import { effectLabel, findEntry, findEffectInfo } from "./fx";
import { pivotGroup } from "./anim";

/* ====================================================================
   SceneScript on a property: continuous (not keyframed) motion whose switches and sliders are user properties.
   The scripts run in WE's scene script engine: update(value) every frame, `value` in the units the editor shows
   (origin px y-up, angles DEGREES, scale factor). Format verified against 73 Workshop scenes: scene.json holds
   {script, scriptproperties:{name: value | {user, value}}, value}.
   ==================================================================== */

export interface SProp { name: string; label: string; kind: "checkbox" | "slider"; value: number | boolean; min?: number; max?: number }

const ENABLED: SProp = { name: "enabled", label: "Enabled", kind: "checkbox", value: true };
const MASTER: SProp = { name: "master", label: "Master switch", kind: "checkbox", value: true };
const AMOUNT: SProp = { name: "amount", label: "Amount", kind: "slider", value: 1, min: 0, max: 3 };
const SPEED: SProp = { name: "speed", label: "Speed", kind: "slider", value: 1, min: 0, max: 3 };

const j = (v: any) => JSON.stringify(v);

export function header(props: SProp[]): string {
  const chain = props.map(p => p.kind === "checkbox"
    ? `\n\t.addCheckbox({ name: ${j(p.name)}, label: ${j(p.label)}, value: ${p.value} })`
    : `\n\t.addSlider({ name: ${j(p.name)}, label: ${j(p.label)}, value: ${p.value}, min: ${p.min}, max: ${p.max}, integer: false })`).join("");
  return `'use strict';\nexport var scriptProperties = createScriptProperties()${chain}\n\t.finish();\n`;
}

/** shared helpers: eased on/off switch (motion fades in and out instead of snapping) and smooth organic noise / breathing curves */
const COMMON = `
var blend = -1;
function ease() {
	var t = scriptProperties.enabled && scriptProperties.master ? 1 : 0;
	blend = blend < 0 ? t : blend + (t - blend) * Math.min(1, engine.frametime * 3);
	return blend;
}
// three incommensurate sines: smooth, never exactly repeating, -1..1
function wave(p, s) { return 0.55 * Math.sin(p + s) + 0.30 * Math.sin(p * 1.73 + s * 2.3) + 0.15 * Math.sin(p * 2.91 + s * 4.1); }
`;

const SHAPES = `
// shapes return -1..1 (breath: quick inhale, slow exhale)
function shape(kind, p, s) {
	if (kind === 'sine') return Math.sin(p + s);
	if (kind === 'breath') return Math.sin(p + s + 0.6 * Math.sin(p + s));
	return wave(p, s);
}
`;

const PARTICLE_PROPS = ["count", "rate", "size", "speed", "lifetime"];
type Prop = "origin" | "angles" | "scale";
const apply2 = (prop: Prop, a: string, b: string) =>
  prop === "angles" ? `o.z += A[0] * k * ${a};` : `o.x += A[0] * k * ${a}; o.y += A[1] * k * ${prop === "scale" ? a : b};`;

interface Built { props: SProp[]; code: string; /** user properties the script needs in project.json (e.g. a usershortcut) */ create?: PropSpec[] }
type Params = Record<string, any>;

type Kind = "vector" | "number" | "visible" | "text" | "color";
interface Template {
  doc: string;
  targets: string[];
  /** the kinds of property it can drive (what update() receives and returns) */
  kinds: Kind[];
  build(prop: string, p: Params): Built;
}

const num = (v: any, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const amp = (v: any, d: number[]) => (v === undefined ? d : Array.isArray(v) ? v.map(Number) : [Number(v), Number(v)]);

export const SCRIPT_TEMPLATES: Record<string, Template> = {
  wobble: {
    doc: "Organic loop motion of origin / angles / scale: amplitude = px [x,y] / degrees [z] / scale delta [x,y]. shape noise (default, never repeats) | sine | breath. period = seconds of the slowest component. publish:<name> shares the current offsets so `lag` scripts on other layers can follow through (head behind the body, hair behind the head). Script properties: enabled, amount, speed.",
    targets: ["origin", "angles", "scale"], kinds: ["vector"],
    build(prop, p) {
      const A = amp(p.amplitude, prop === "angles" ? [1, 0] : [8, 8]);
      const code = `${header([ENABLED, MASTER, AMOUNT, SPEED])}${COMMON}${SHAPES}
const A = ${j(A)}, PERIOD = ${num(p.period, 6)}, SEED = ${num(p.seed, 1)}, SHAPE = ${j(p.shape ?? "noise")}, PUBLISH = ${j(p.publish ?? "")};
var base, phase = 0;
export function init(value) { base = value.copy(); phase = SEED * 7.7; }
export function update(value) {
	var k = ease() * scriptProperties.amount;
	phase += engine.frametime * scriptProperties.speed * 6.2831853 / PERIOD;
	var f0 = shape(SHAPE, phase, SEED), f1 = shape(SHAPE, phase * 1.13 + 2.0, SEED + 1.7);
	var o = base.copy();
	${apply2(prop as Prop, "f0", "f1")}
	if (PUBLISH) shared[PUBLISH] = { a: A[0] * k * f0, b: A[1] * k * f1 };
	return o;
}
`;
      return { props: [ENABLED, MASTER, AMOUNT, SPEED], code };
    },
  },

  cursor: {
    doc: "Lean toward the mouse cursor, smoothed (spring): amplitude = px [x,y] / degrees [z] / scale delta at the screen edge; smooth = how fast it follows (default 3 /s). invert:true leans away. Script properties: enabled, amount.",
    targets: ["origin", "angles", "scale"], kinds: ["vector"],
    build(prop, p) {
      const A = amp(p.amplitude, prop === "angles" ? [1, 0] : [10, 6]);
      const sign = p.invert ? -1 : 1;
      const code = `${header([ENABLED, MASTER, AMOUNT])}${COMMON}
const A = ${j(A)}, SMOOTH = ${num(p.smooth, 3)}, SIGN = ${sign};
var base, cx = 0, cy = 0;
export function init(value) { base = value.copy(); }
export function update(value) {
	var k = ease() * scriptProperties.amount * SIGN;
	var cs = engine.canvasSize, c = input.cursorWorldPosition;
	var tx = Math.max(-1, Math.min(1, (c.x / cs.x - 0.5) * 2)), ty = Math.max(-1, Math.min(1, (c.y / cs.y - 0.5) * 2));
	var f = 1 - Math.exp(-Math.min(engine.frametime, 0.1) * SMOOTH);
	cx += (tx - cx) * f; cy += (ty - cy) * f;
	var o = base.copy();
	${prop === "angles" ? "o.z += A[0] * k * cx;" : prop === "scale" ? "o.x += A[0] * k * cx; o.y += A[1] * k * cy;" : "o.x += A[0] * k * cx; o.y += A[1] * k * cy;"}
	return o;
}
`;
      return { props: [ENABLED, MASTER, AMOUNT], code };
    },
  },

  lag: {
    doc: "Follow-through: spring that trails a motion published by a `wobble` (publish:<name>) - the head tilting after the body, the hair after the head. from = channel name, component 0|1 (a or b of the publisher), gain = target units per source unit (negative = counter-motion), smooth = spring frequency in rad/s (default 5), damping 0..1 (default 0.35 = a little overshoot). Script properties: enabled, amount.",
    targets: ["origin", "angles", "scale"], kinds: ["vector"],
    build(prop, p) {
      if (!p.from) throw new Error('lag needs from:"<channel>" (the publish name of a wobble).');
      const code = `${header([ENABLED, MASTER, AMOUNT])}${COMMON}
const FROM = ${j(p.from)}, COMP = ${num(p.component, 0) ? "'b'" : "'a'"}, GAIN = ${num(p.gain, 1)}, W = ${num(p.smooth, 5)}, Z = ${num(p.damping, 0.35)};
var base, x = 0, v = 0;
export function init(value) { base = value.copy(); }
export function update(value) {
	var b = ease() * scriptProperties.amount;
	var src = shared[FROM], tgt = src ? src[COMP] * GAIN : 0;
	var dt = Math.min(engine.frametime, 1 / 30);
	v += (W * W * (tgt - x) - 2 * Z * W * v) * dt; x += v * dt;
	var o = base.copy();
	${prop === "angles" ? "o.z += x * b;" : prop === "scale" ? "o.x += x * b; o.y += x * b;" : "o.x += x * b; o.y += x * b;"}
	return o;
}
`;
      return { props: [ENABLED, MASTER, AMOUNT], code };
    },
  },

  gain: {
    doc: "Scales a number (alpha, brightness, an effect parameter such as waterwaves strength or scroll speed): value = base x amount, fading to `off` (default 0) when disabled - or to the steady base x amount with hold:true (only the modulation switches off). shape (none | noise | sine | beat | burst) + variation 0..1 adds a living modulation (hair gusts, a pulsing aura, a heartbeat, a flash every `period` s). root:true uses sqrt(amount) for effects whose reach grows with strength squared (waterwaves), so the slider is linear in pixels. Script properties: enabled, master, amount, speed.",
    targets: ["alpha", "brightness", "intensity", "effect parameter (scalar)"], kinds: ["number"],
    build(_prop, p) {
      const shape = String(p.shape ?? "none");
      const code = `${header([ENABLED, MASTER, AMOUNT, SPEED])}${COMMON}
const SHAPE = ${j(shape)}, VAR = ${num(p.variation, 0)}, PERIOD = ${num(p.period, 5)}, SEED = ${num(p.seed, 1)}, OFF = ${num(p.off, 0)}, HOLD = ${!!p.hold}, ROOT = ${!!p.root};
var base, phase = 0;
export function init(value) { base = value; phase = SEED * 7.7; }
function env(p) {   // 0..1
	var c = (p / 6.2831853) % 1;
	if (SHAPE === 'beat') return Math.exp(-Math.pow((c - 0.10) / 0.05, 2)) + 0.6 * Math.exp(-Math.pow((c - 0.28) / 0.06, 2));
	if (SHAPE === 'burst') return Math.exp(-c * 7);
	return 0.5 + 0.5 * (SHAPE === 'sine' ? Math.sin(p + SEED) : wave(p, SEED));
}
export function update(value) {
	var b = ease();
	phase += engine.frametime * scriptProperties.speed * 6.2831853 / PERIOD;
	var m = SHAPE === 'none' ? 1 : 1 + VAR * (2 * Math.min(1, env(phase)) - 1);
	var A = Math.max(0, scriptProperties.amount);
	var target = ROOT ? base * Math.sqrt(A * m) : base * A * m;
	var rest = HOLD ? (ROOT ? base * Math.sqrt(A) : base * A) : OFF;
	return rest + (target - rest) * b;
}
`;
      return { props: [ENABLED, MASTER, AMOUNT, SPEED], code };
    },
  },
  click: {
    doc: "Mouse-click effect: put it on the `visible` of a transparent full-canvas solid layer (alpha 0, on top). On every press the next layer of targets:[names] (hidden particle systems, taken in turns) is moved to the cursor and shown for duration s (default 0.4). Script properties: enabled, master.",
    targets: ["visible"], kinds: ["visible"],
    build(_prop, p) {
      const T = (Array.isArray(p.targets) ? p.targets : p.targets ? [p.targets] : []).map(String);
      if (!T.length) throw new Error('click needs targets:["layer name", ...]: hidden particle layers that are shown at the cursor.');
      const code = `${header([ENABLED, MASTER])}
const T = ${j(T)}, DUR = ${num(p.duration, 0.4)};
var i = 0;
export function update(value) { return value; }
export function cursorDown(event) {
	if (!(scriptProperties.enabled && scriptProperties.master)) return;
	var l = thisScene.getLayer(T[i]); i = (i + 1) % T.length;
	l.origin = new Vec3(event.worldPosition.x, event.worldPosition.y, 0);
	l.visible = true;
	engine.setTimeout(function () { l.visible = false; }, DUR * 1000);
}
`;
      return { props: [ENABLED, MASTER], code };
    },
  },
  scene: {
    doc: "Scene-wide switch riding on a layer's alpha (the alpha is returned unchanged): what = parallax (default) | bloom | shake. `enabled` turns the camera parallax / bloom / camera shake on, `amount` scales base (e.g. base 0.6 for parallax = the amount you would set in scene_settings). Script properties: enabled, master, amount.",
    targets: ["alpha"], kinds: ["number"],
    build(_prop, p) {
      const [on, amt] = p.what === "bloom" ? ["bloom", "bloomstrength"] : p.what === "shake" ? ["camerashake", "camerashakeamplitude"] : ["cameraparallax", "cameraparallaxamount"];
      const code = `${header([ENABLED, MASTER, AMOUNT])}
const BASE = ${num(p.base, 1)};
export function update(value) {
	var on = scriptProperties.enabled && scriptProperties.master;
	thisScene.${on} = on;
	if (on) thisScene.${amt} = BASE * scriptProperties.amount;
	return value;
}
`;
      return { props: [ENABLED, MASTER, AMOUNT], code };
    },
  },

  audio: {
    doc: "React to the music (needs sound playing; project.json supportsaudioprocessing is set for you). band bass (default, <250 Hz) | mid | treble (>4 kHz) | all, or [firstBin, lastBin] of the 16 spectrum bins (the loudest bin of the band counts). On NUMBERS (alpha, brightness, light intensity / radius, effect parameter) the value pulses between base x min (default 0.4, silence) and base x max (default 1.6, loud beat). On origin / angles / scale amplitude = px / degrees / scale delta added at full level (defaults: origin [0,20], angles [4], scale [0.08,0.08]). attack (default 25 /s) and smooth (decay, default 6 /s) shape the response. Script properties: enabled, master, amount (reaction, 0 = steady), sensitivity (music is quiet or loud: the viewer can tune it).",
    targets: ["alpha", "brightness", "intensity", "radius", "effect parameter (scalar)", "origin", "angles", "scale"], kinds: ["number", "vector"],
    build(prop, p) {
      const [lo, hi] = Array.isArray(p.band) ? p.band.map(Number) : (AUDIO_BANDS[String(p.band ?? "bass")] ?? (() => { throw new Error(`band must be bass, mid, treble, all or [firstBin, lastBin] (0..15), got "${p.band}".`); })());
      if (!(lo >= 0 && hi <= 15 && lo <= hi)) throw new Error("band bins must satisfy 0 <= first <= last <= 15.");
      const SENS: SProp = { name: "sensitivity", label: "Sensitivity", kind: "slider", value: num(p.sensitivity, 1), min: 0, max: 4 };
      const REACT: SProp = { ...AMOUNT, label: "Reaction" };
      const numeric = ["alpha", "brightness", "intensity", "radius", "effect"].includes(prop);
      const A = amp(p.amplitude, prop === "angles" ? [4, 0] : prop === "scale" ? [0.08, 0.08] : [0, 20]);
      const code = `${header([ENABLED, MASTER, REACT, SENS])}${COMMON}
const audio = engine.registerAudioBuffers(engine.AUDIO_RESOLUTION_16);
const LO = ${lo}, HI = ${hi}, ATTACK = ${num(p.attack, 25)}, DECAY = ${num(p.smooth, 6)}, MIN = ${num(p.min, 0.4)}, MAX = ${num(p.max, 1.6)}, A = ${j(A)};
var base, lvl = 0;
export function init(value) { base = ${numeric ? "value" : "value.copy()"}; }
export function update(value) {
	var s = 0;
	for (var i = LO; i <= HI; i++) s = Math.max(s, audio.average[i]);
	var raw = Math.min(1, s * scriptProperties.sensitivity);
	var dt = Math.min(engine.frametime, 0.1);
	lvl += (raw - lvl) * (1 - Math.exp(-dt * (raw > lvl ? ATTACK : DECAY)));
	var k = ease() * scriptProperties.amount;
${numeric ? "\treturn base * (1 + (MIN + (MAX - MIN) * lvl - 1) * k);" : `\tvar o = base.copy();\n\t${apply2(prop as Prop, "lvl", "lvl")}\n\treturn o;`}
}
`;
      return { props: [ENABLED, MASTER, REACT, SENS], code };
    },
  },

  event: {
    doc: "Reacts to ANIMATION EVENTS (animate_layer events:[{t,name}]) of the animation on THE SAME layer (when a pivot group carries the animation, put the script on the group): goes on the layer's visible. on = event name (default: every event). Then: targets:[layer names] are shown for duration s (default 0.5), emit:[particle layer names] fire count (default 30) particles, sounds:[sound layer names] are played. Script properties: enabled, master.",
    targets: ["visible"], kinds: ["visible"],
    build(_prop, p) {
      const L = (v: any) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
      if (!L(p.targets).length && !L(p.emit).length && !L(p.sounds).length) throw new Error("event needs targets (layers to show), emit (particle layers) and / or sounds (sound layers).");
      const code = `${header([ENABLED, MASTER])}
const ON = ${j(p.on ?? "")}, T = ${j(L(p.targets))}, E = ${j(L(p.emit))}, S = ${j(L(p.sounds))}, DUR = ${num(p.duration, 0.5)}, COUNT = ${num(p.count, 30)};
export function update(value) { return value; }
export function animationEvent(event) {
	if (!(scriptProperties.enabled && scriptProperties.master)) return;
	if (ON && event.name !== ON) return;
	T.forEach(function (n) { var l = thisScene.getLayer(n); if (!l) return; l.visible = true; engine.setTimeout(function () { l.visible = false; }, DUR * 1000); });
	E.forEach(function (n) { var l = thisScene.getLayer(n); if (l) l.emitParticles(COUNT); });
	S.forEach(function (n) { var l = thisScene.getLayer(n); if (l) l.play(); });
}
`;
      return { props: [ENABLED, MASTER], code };
    },
  },

  media: {
    doc: "Follow the playing music (Windows media integration). On a TEXT property (add_text): shows format (default '{artist} - {title}'; also {album}) of the current track, fallback (default empty) when nothing plays. On a COLOR property: eases to the album art colour: which = primary (default) | secondary | tertiary | text; back to the base colour when there is no cover. Script properties: enabled, master (colour: also speed in /s).",
    targets: ["text", "color"], kinds: ["text", "color"],
    build(prop, p) {
      if (prop === "text") {
        const code = `${header([ENABLED, MASTER])}
const FORMAT = ${j(p.format ?? "{artist} - {title}")}, FALLBACK = ${j(p.fallback ?? "")};
var s = FALLBACK;
export function update(value) { return scriptProperties.enabled && scriptProperties.master ? s : FALLBACK; }
export function mediaPropertiesChanged(event) {
	var t = FORMAT.split('{artist}').join(event.artist || '').split('{title}').join(event.title || '').split('{album}').join(event.albumTitle || '');
	s = (event.title || event.artist) ? t : FALLBACK;
}
export function mediaPlaybackChanged(event) { if (event.state === MediaPlaybackEvent.PLAYBACK_STOPPED) s = FALLBACK; }
`;
        return { props: [ENABLED, MASTER], code };
      }
      const which = ({ primary: "primaryColor", secondary: "secondaryColor", tertiary: "tertiaryColor", text: "textColor" } as Record<string, string>)[String(p.which ?? "primary")];
      if (!which) throw new Error("which must be primary, secondary, tertiary or text.");
      const SPD: SProp = { ...SPEED, label: "Colour change speed", value: 2, min: 0.2, max: 8 };
      const code = `${header([ENABLED, MASTER, SPD])}
var base, goal = null, cur = null;
export function init(value) { base = value.copy(); cur = value.copy(); }
export function update(value) {
	var t = scriptProperties.enabled && scriptProperties.master && goal ? goal : base;
	var f = 1 - Math.exp(-Math.min(engine.frametime, 0.1) * scriptProperties.speed);
	cur = new Vec3(cur.x + (t.x - cur.x) * f, cur.y + (t.y - cur.y) * f, cur.z + (t.z - cur.z) * f);
	return cur;
}
export function mediaThumbnailChanged(event) { goal = event.hasThumbnail ? event.${which}.copy() : null; }
`;
      return { props: [ENABLED, MASTER, SPD], code };
    },
  },

  emit: {
    doc: "Bursts on a particle system (fireworks, sparks, puffs): goes on the particle layer's visible; every period s (default 2, +- jitter 0..1 of it, default 0.3) it emits count (default 20) particles at once on top of the normal emission. Script properties: enabled, master.",
    targets: ["visible"], kinds: ["visible"],
    build(_prop, p) {
      const code = `${header([ENABLED, MASTER])}
const PERIOD = ${num(p.period, 2)}, JIT = ${num(p.jitter, 0.3)}, COUNT = ${num(p.count, 20)};
var t = 0, next = PERIOD;
export function update(value) {
	if (!(scriptProperties.enabled && scriptProperties.master)) return value;
	t += engine.frametime;
	if (t >= next) { t = 0; next = PERIOD * (1 + JIT * (Math.random() * 2 - 1)); thisLayer.emitParticles(COUNT); }
	return value;
}
`;
      return { props: [ENABLED, MASTER], code };
    },
  },

  daytime: {
    doc: "Time of day by the viewer's local clock: on a NUMBER (alpha of a night overlay / lit-windows layer, brightness, light intensity, particle count / rate) the value is base x amount between hours:[from,to] (default [18,6] = night; the interval may wrap midnight) and fades in / out over fade hours (default 1), base x off (default 0) outside. Several layers with complementary hours make dawn / day / dusk / night. Script properties: enabled, master, amount, hour (-1 = real clock; 0..24 previews a time of day - bind it so the viewer can try it).",
    targets: ["alpha", "brightness", "intensity", "radius", "count", "rate", "effect parameter (scalar)"], kinds: ["number"],
    build(_prop, p) {
      const [from, to] = Array.isArray(p.hours) && p.hours.length === 2 ? p.hours.map(Number) : [18, 6];
      if (![from, to].every(h => h >= 0 && h <= 24)) throw new Error("hours must be [from, to] between 0 and 24, e.g. [18, 6] for the night.");
      const HOUR: SProp = { name: "hour", label: "Preview hour (-1 = real clock)", kind: "slider", value: -1, min: -1, max: 24 };
      const code = `${header([ENABLED, MASTER, AMOUNT, HOUR])}${COMMON}
const FROM = ${from}, TO = ${to}, FADE = Math.max(0.01, ${num(p.fade, 1)}), OFF = ${num(p.off, 0)};
var base, w = 0, last = -1;
export function init(value) { base = value; }
function weight(h) {
	var d = (h - FROM + 24) % 24, len = (TO - FROM + 24) % 24 || 24;
	if (d >= len) return 0;
	var x = Math.min(1, d / FADE, (len - d) / FADE);
	return x * x * (3 - 2 * x);
}
export function update(value) {
	if (last < 0 || engine.runtime - last > 1) {
		last = engine.runtime;
		var h = scriptProperties.hour, now = new Date();
		w = weight(h >= 0 ? h : now.getHours() + now.getMinutes() / 60);
	}
	return base * (OFF + (scriptProperties.amount - OFF) * w * ease());
}
`;
      return { props: [ENABLED, MASTER, AMOUNT, HOUR], code };
    },
  },

  hover: {
    doc: "Reacts to the mouse cursor over THE layer (it must be visible): on a NUMBER (alpha, brightness, particle rate...) eases from base x rest (default 0.6, cursor away) to base x hover (default 1) while the cursor is over it, at smooth /s (default 8). Script properties: enabled, master (off = the plain base value).",
    targets: ["alpha", "brightness", "intensity", "rate", "effect parameter (scalar)"], kinds: ["number"],
    build(_prop, p) {
      const code = `${header([ENABLED, MASTER])}
const REST = ${num(p.rest, 0.6)}, HOVER = ${num(p.hover, 1)}, SMOOTH = ${num(p.smooth, 8)};
var base, over = false, cur = REST;
export function init(value) { base = value; }
export function update(value) {
	var t = scriptProperties.enabled && scriptProperties.master ? (over ? HOVER : REST) : 1;
	cur += (t - cur) * (1 - Math.exp(-Math.min(engine.frametime, 0.1) * SMOOTH));
	return base * cur;
}
export function cursorEnter(event) { over = true; }
export function cursorLeave(event) { over = false; }
`;
      return { props: [ENABLED, MASTER], code };
    },
  },

  toggle: {
    doc: "Click-to-switch with memory: clicking THIS layer (a button; the script goes on its alpha or visible, value unchanged) shows / hides targets:[layer names] together and remembers the state across restarts (localStorage under key, default the layer's id). start = shown on the very first run (default true). Script properties: enabled.",
    targets: ["alpha", "visible"], kinds: ["number", "visible"],
    build(_prop, p) {
      const T = (Array.isArray(p.targets) ? p.targets : p.targets ? [p.targets] : []).map(String);
      if (!T.length) throw new Error('toggle needs targets:["layer name", ...]: the layers the click shows / hides.');
      const code = `${header([ENABLED])}
const T = ${j(T)}, KEY = ${j(String(p.key ?? "toggle_" + p.layerId))};
var on = ${p.start === false ? "false" : "true"}, started = false;
function apply() { T.forEach(function (n) { var l = thisScene.getLayer(n); if (l) l.visible = on; }); }
export function update(value) {
	if (!started) { started = true; var s = localStorage.get(KEY); if (typeof s === 'boolean') on = s; apply(); }   // first frame: every layer exists by now
	return value;
}
export function cursorClick(event) {
	if (!scriptProperties.enabled) return;
	on = !on; localStorage.set(KEY, on); apply();
}
`;
      return { props: [ENABLED], code };
    },
  },

  launch: {
    doc: "Click opens an application the VIEWER chooses: creates a 'usershortcut' user property (shortcut, default 'shortcut1', label default 'Application') and a click on THIS layer (script on its alpha or visible, value unchanged) runs engine.openUserShortcut. Script properties: enabled.",
    targets: ["alpha", "visible"], kinds: ["number", "visible"],
    build(_prop, p) {
      const key = String(p.shortcut ?? "shortcut1");
      const code = `${header([ENABLED])}
export function update(value) { return value; }
export function cursorClick(event) { if (scriptProperties.enabled) engine.openUserShortcut(${j(key)}); }
`;
      return { props: [ENABLED], code, create: [{ property: key, label: String(p.label ?? "Application"), type: "usershortcut" }] };
    },
  },
};

/** the 16 spectrum bins of engine.registerAudioBuffers(16) that make a band. Measured with pure tones: 60 Hz -> bin 0, 400 Hz -> 4-5, 2 kHz -> 9 (about half an octave per bin, up to ~18 kHz) */
const AUDIO_BANDS: Record<string, [number, number]> = { bass: [0, 3], mid: [4, 10], treble: [11, 15], all: [0, 15] };

/** The user properties a script exposes a script exposes -> bindings in scene.json ("scriptproperties"). */
function bindAll(dir: string, props: SProp[], bind: Record<string, any> | undefined): { sp: Record<string, any>; note: string[] } {
  const sp: Record<string, any> = {};
  const note: string[] = [];
  for (const p of props) {
    const b = bind?.[p.name];
    if (isPropSpec(b)) {
      const spec: PropSpec = { type: p.kind === "checkbox" ? "bool" : "slider", min: p.min, max: p.max, label: p.label, ...b };
      const r = bindProperty(dir, spec, p.value);
      sp[p.name] = r;
      note.push(`${p.name} -> user property "${b.property}"`);
    } else sp[p.name] = b !== undefined && b !== false ? b : p.value;
  }
  return { sp, note };
}

export interface ScriptArgs {
  template?: string;
  /** custom script source (use with `props` to declare script properties) */
  code?: string;
  props?: { name: string; label?: string; kind?: "checkbox" | "slider"; value: number | boolean; min?: number; max?: number }[];
  property?: "origin" | "angles" | "scale" | "alpha" | "brightness" | "visible" | "intensity" | "radius" | "text" | "color" | "count" | "rate" | "size" | "speed" | "lifetime";
  effect?: string | number; param?: string;
  pivot?: string | { x: number; y: number };
  /** template parameters */
  band?: string | number[]; sensitivity?: number; attack?: number; min?: number; max?: number; on?: string; emit?: string | string[]; sounds?: string | string[]; count?: number; jitter?: number;
  format?: string; fallback?: string; which?: string;
  hours?: number[]; fade?: number; rest?: number; hover?: number; key?: string; start?: boolean; shortcut?: string; label?: string;
  amplitude?: number | number[]; period?: number; seed?: number; shape?: string; variation?: number; off?: number; what?: string; base?: number; hold?: boolean; root?: boolean;
  targets?: string | string[]; duration?: number;
  publish?: string; from?: string; component?: number; gain?: number; smooth?: number; damping?: number; invert?: boolean;
  /** script property name (enabled, amount, speed, ...) -> {property,label,...} user property, or a fixed value */
  bind?: Record<string, any>;
  clear?: boolean;
}

export function listScripts(): string {
  return [
    "SceneScript templates for add_script (continuous motion; every one has an `enabled` switch + `amount` slider you can bind to user properties via bind:{enabled:{property,label}, amount:{property,label,min,max}}):",
    ...Object.entries(SCRIPT_TEMPLATES).map(([n, t]) => `- ${n} [${t.targets.join(", ")}]: ${t.doc}`),
    "Custom: code + props (script properties). The script sees values in editor units (origin px y-UP, angles in DEGREES). Globals: engine (runtime, frametime, canvasSize), input.cursorWorldPosition, shared, thisLayer, thisScene.",
  ].join("\n");
}

export function addScript(project: string, layerRef: string | number, a: ScriptArgs): string {
  const ctx = openScene(project);
  const { scene, dir } = ctx;
  let layer = findLayer(scene, layerRef);
  const notes: string[] = [];

  /* ---- target: effect parameter or layer property ---- */
  let holder: Obj, key: string, dflt: any, prop: string;
  if (a.effect !== undefined) {
    if (!a.param) throw new Error("param is required when scripting an effect parameter.");
    const idx = findEntry(layer, a.effect);
    const entry = layer.effects[idx];
    const info = findEffectInfo(effectLabel(entry), dir);
    if (!info) throw new Error(`Cannot read ${entry.file}.`);
    const pr = matchParam(info, a.param);
    if (!pr) throw new Error(`Unknown parameter "${a.param}". Valid: ${info.params.map(x => x.key).join(", ")}.`);
    const pass = entry.passes[pr.pass]; pass.constantshadervalues = pass.constantshadervalues ?? {};
    holder = pass.constantshadervalues; key = pr.key; prop = "effect";
    const cur = holder[key];
    dflt = cur && typeof cur === "object" && "value" in cur ? cur.value : cur ?? pr.default;
    if (a.clear) { if (cur && typeof cur === "object" && cur.script) holder[key] = cur.value; saveScene(ctx); return `Removed the script from ${key}.`; }
  } else {
    if (!a.property) throw new Error("Give property (origin, angles, scale, alpha, brightness, visible, text, color, intensity / radius of a light) or effect + param.");
    prop = a.property;
    if ((prop === "angles" || prop === "scale") && a.pivot && a.pivot !== "center") {
      const { group, created } = pivotGroup(ctx, layer, a.pivot);
      notes.push(`${created ? "Created" : "Reusing"} pivot group [${group.id}] "${group.name}"; the script runs on the group, the layer follows it.`);
      layer = group;
    }
    holder = layer; key = prop;
    // particle systems keep alpha / brightness / count / rate / size / speed / lifetime multipliers in instanceoverride
    if (PARTICLE_PROPS.includes(prop) || (kindOf(layer) === "particle" && (prop === "alpha" || prop === "brightness"))) {
      if (kindOf(layer) !== "particle") throw new Error(`${prop} is a particle property: "${layer.name}" is not a particle system.`);
      layer.instanceoverride = layer.instanceoverride ?? { id: nextId(scene) };
      holder = layer.instanceoverride;
    }
    const cur = holder[key];
    dflt = cur && typeof cur === "object" && "value" in cur ? cur.value : cur;
    if (a.clear) { if (cur && typeof cur === "object" && cur.script) holder[key] = cur.value; saveScene(ctx); return `Removed the script from ${key} of [${layer.id}] "${layer.name}".`; }
    if (dflt === undefined) dflt = prop === "text" ? "" : prop === "color" ? "1.00000 1.00000 1.00000" : prop === "scale" ? "1.00000 1.00000 1.00000" : prop === "visible" ? true : ["alpha", "brightness", "intensity", "radius", ...PARTICLE_PROPS].includes(prop) ? 1 : "0.00000 0.00000 0.00000";
    if (cur && typeof cur === "object" && "user" in cur) throw new Error(`${key} is bound to a user property; it cannot also have a script.`);
  }

  /* ---- script source ---- */
  let built: Built;
  if (a.code) {
    built = { code: a.code, props: (a.props ?? []).map(p => ({ name: p.name, label: p.label ?? p.name, kind: p.kind ?? (typeof p.value === "boolean" ? "checkbox" : "slider"), value: p.value, min: p.min, max: p.max })) };
  } else {
    const t = a.template ? SCRIPT_TEMPLATES[a.template] : undefined;
    if (!t) throw new Error(`Unknown template "${a.template}". Templates: ${Object.keys(SCRIPT_TEMPLATES).join(", ")} (or pass code).`);
    const scalar = ["alpha", "brightness", "intensity", "radius", "effect", ...PARTICLE_PROPS].includes(prop);
    const propKind: Kind = prop === "visible" ? "visible" : scalar ? "number" : prop === "text" ? "text" : prop === "color" ? "color" : "vector";
    if (!t.kinds.includes(propKind)) throw new Error(`Template ${a.template} does not fit ${prop === "effect" ? "an effect parameter" : prop}: it goes on ${t.targets.join(", ")}.`);
    built = t.build(prop, { seed: layer.id * 1.37, layerId: layer.id, ...a });
  }
  for (const spec of built.create ?? []) bindProperty(dir, spec, "");
  const { sp, note } = bindAll(dir, built.props, a.bind);
  holder[key] = { script: built.code, scriptproperties: sp, value: dflt };
  saveScene(ctx);
  return [
    `Script ${a.template ?? "custom"} attached to ${prop === "effect" ? `effect parameter ${key}` : key} of [${layer.id}] "${layer.name}".`,
    note.length ? `Bound: ${note.join("; ")}.` : "No script property is bound: all values are fixed. Pass bind:{enabled:{property:'hair_on', label:'Hair motion'}, amount:{property:'hair_amount', label:'Hair intensity', min:0, max:2}} to expose them in the properties panel.",
    ...notes,
    "Scripts are not simulated by preview_scene: judge them with capture_wallpaper.",
  ].join("\n");
}
