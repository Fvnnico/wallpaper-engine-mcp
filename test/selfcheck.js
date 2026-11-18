// Smallest check that fails if the math the engine depends on breaks. Run: npm run check (after npm run build).
// Everything here was verified against the real engine (WE 2.8) - see PLAN.md "Verified facts".
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const dist = "../dist/";
const { encodeTex, texToRgba, texHeader, texBytes, mp4Size, TEX_DXT5, TEX_DXT1, TEX_RGBA8888 } = require(dist + "tex");
const { perfReport } = require(dist + "tools/perf");
const { overrideProperties } = require(dist + "tools/capture");
const { buildMask } = require(dist + "tools/fx");
const { addMotionRig } = require(dist + "tools/rig");
const { worldXf, localFromWorld, originForAnchor, anglesStr, setLocal, PT_PX, utilKind, bindProperty, insertAt, FIXED_DEPTH, openScene } = require(dist + "sceneio");
const { waveChannels } = require(dist + "tools/anim");
const { formatValue } = require(dist + "effects");
const { addUtilLayerCore, importSprite, importVideo, updateLayer, sceneSettings } = require(dist + "tools/scene");
const { addLight } = require(dist + "tools/light");
const { addScript } = require(dist + "tools/script");
const { animateLayer } = require(dist + "tools/anim");
const { usesAudio } = require(dist + "sceneio");
const sharp = require("sharp");
const { copyExampleLayer } = require(dist + "tools/examples");
const { openPkg } = require(dist + "pkg");

(async () => {
  // 1. .tex roundtrip: opaque pixels survive, transparent ones stay transparent (colour bleeding only touches RGB)
  const px = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 9, 9, 9, 0, 0, 0, 255, 255]); // 2x2
  const back = await texToRgba(await encodeTex(px, 2, 2));
  assert.deepStrictEqual([back.w, back.h], [2, 2]);
  for (const i of [0, 1, 3]) assert.deepStrictEqual([...back.rgba.subarray(i * 4, i * 4 + 4)], [...px.subarray(i * 4, i * 4 + 4)], `pixel ${i}`);
  assert.strictEqual(back.rgba[11], 0, "transparent pixel keeps alpha 0");

  // 2. rotation is stored in RADIANS (WE reads 25 as 25 rad) and read back as degrees, counter-clockwise positive
  assert.strictEqual(anglesStr(90), "0.00000 0.00000 1.57080");
  const scene = { objects: [{ id: 1, origin: "100 200 0", angles: anglesStr(90), scale: "2 2 1" }, { id: 2, parent: 1, origin: "10 0 0" }] };
  const pw = worldXf(scene, scene.objects[0]);
  assert.ok(Math.abs(pw.rot - 90) < 1e-3, "world rot in degrees");
  const cw = worldXf(scene, scene.objects[1]); // child 10 units right of a parent rotated 90deg CCW and scaled 2 -> 20 units UP
  assert.ok(Math.abs(cw.x - 100) < 1e-3 && Math.abs(cw.y - 220) < 1e-3, `child world ${cw.x},${cw.y}`); // angles are stored with 5 decimals
  const l = localFromWorld(scene, scene.objects[0], cw);
  assert.ok(Math.abs(l.x - 10) < 1e-3 && Math.abs(l.y) < 1e-3 && Math.abs(l.rot) < 1e-3, "localFromWorld inverts worldXf");
  const o = {}; setLocal(o, { x: 1, y: 2, sx: 1, sy: 1, rot: 45 });
  assert.strictEqual(o.angles, anglesStr(45));

  // 3. anchor: the bottom-centre of a 100x200 layer rotated 90deg CCW lands on the given point
  const [cx, cy] = originForAnchor(500, 500, 100, 200, 1, 1, 90, "bottom"); // bottom edge points to +x after the rotation
  assert.ok(Math.abs(cx - 400) < 1e-6 && Math.abs(cy - 500) < 1e-6, `anchor centre ${cx},${cy}`);

  // 4. animation loops are closed (last keyframe == first) so there is no pop at the wrap
  for (const wave of ["sine", "triangle", "pulse", "noise"]) {
    const { ch } = waveChannels(1, { wave, period: 4, amp: [3], phase: [0], mode: "loop" });
    assert.ok(Math.abs(ch[0][0].value - ch[0][ch[0].length - 1].value) < 1e-9, `${wave} loop closed`);
  }

  // 5. text: WE draws pointsize N with an N*300/72 px em
  assert.ok(Math.abs(PT_PX - 4.16667) < 1e-4);

  // 6. effect colour params are stored as "r g b" (0-1); a "#ff0000" string renders black in WE
  const colorParam = { key: "color", label: "Color", type: "color", color: true, pass: 0 };
  assert.strictEqual(formatValue(colorParam, "#ff0000"), "1.00000 0.00000 0.00000");
  assert.strictEqual(formatValue(colorParam, [0, 0.5, 1]), "0.00000 0.50000 1.00000");

  // 7. utility layers: a solid is a placed rectangle (canvas centre by default, black); a fullscreen post-process layer has no geometry
  const ctx = { dir: ".", file: "scene.json", scene: { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [] } };
  const solid = addUtilLayerCore(ctx, { kind: "solid" });
  assert.strictEqual(utilKind(solid), "solid");
  assert.strictEqual(solid.origin, "960.00000 540.00000 0.00000");
  assert.strictEqual(solid.size, "1920.00000 1080.00000");
  assert.strictEqual(solid.color, "0.00000 0.00000 0.00000");
  const full = addUtilLayerCore(ctx, { kind: "fullscreen" });
  assert.ok(utilKind(full) === "fullscreen" && full.origin === undefined && full.size === undefined);
  assert.deepStrictEqual(ctx.scene.objects.map(o => o.id), [1, 2]);

  // 8. combo condition binding = the form hand-made scenes use for "visible while the style combo equals N"
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "we-selfcheck-"));
  fs.writeFileSync(path.join(tmp, "project.json"), "{}");
  const style = { property: "style", type: "combo", options: [{ label: "A", value: "1" }, { label: "B", value: "2" }], value: "1" };
  assert.deepStrictEqual(bindProperty(tmp, { ...style, condition: 2 }, true), { user: { name: "style", condition: "2" }, value: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, "project.json"), "utf8")).general.properties.style.type, "combo");
  fs.rmSync(tmp, { recursive: true, force: true });

  // 9. camera parallax on: layers without an explicit depth are pinned (WE would move them, and a group + child twice); explicit depths win
  const sc = { general: { cameraparallax: true }, objects: [] };
  insertAt(sc, { id: 1 }); insertAt(sc, { id: 2, parallaxDepth: "0.30000 0.30000" }); insertAt(sc, { id: 3, sound: ["a.mp3"] });
  assert.deepStrictEqual(sc.objects.map(o => o.parallaxDepth), [FIXED_DEPTH, "0.30000 0.30000", undefined]);
  // 10. tile:true writes a repeating texture (flags 0), default clamps (flags 2); texToRgba still reads both
  const flat = Buffer.alloc(4 * 4 * 4, 200);
  for (const [tile, flags] of [[false, 2], [true, 0]]) {
    const t = await encodeTex(flat, 4, 4, { tile });
    assert.strictEqual(t.readInt32LE(t.indexOf("TEXI0001") + 9 + 4), flags);
    assert.strictEqual((await texToRgba(t)).w, 4);
  }
  // 11. SceneScript templates: every one parses and runs against a mocked engine; motion stays finite and bounded, `enabled:false` returns the base pose
  const vm = require("vm");
  const { SCRIPT_TEMPLATES } = require(dist + "tools/script");
  class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } copy() { return new Vec3(this.x, this.y, this.z); } }
  const runTemplate = (name, prop, params, enabled, frames = 240) => {
    const src = SCRIPT_TEMPLATES[name].build(prop, params).code.replace(/^import .*$/gm, "").replace(/export (var|let|const|function)/g, "$1");
    const props = {};
    const chain = { addCheckbox: p => (props[p.name] = p.value, chain), addSlider: p => (props[p.name] = p.value, chain), finish: () => props };
    const shared = { sway: { a: 1, b: 1 } }, scene = {};
    const ctx = vm.createContext({ Vec3, Math, shared, createScriptProperties: () => chain, thisScene: scene, input: { cursorWorldPosition: new Vec3(2000, 300) },
      engine: { frametime: 1 / 60, runtime: 0, canvasSize: { x: 2560, y: 1440 } } });
    vm.runInContext(src + "\nthis.__init = typeof init === 'function' ? init : null; this.__update = update; this.__props = scriptProperties;", ctx);
    ctx.__props.enabled = enabled;
    const base = typeof params.base0 === "number" ? params.base0 : new Vec3(100, 200, 3);
    if (typeof ctx.__init === "function") ctx.__init(base);
    let out;
    for (let i = 0; i < frames; i++) out = ctx.__update(typeof base === "number" ? base : base.copy());
    return { out, base, scene };
  };
  for (const [name, prop, params] of [["wobble", "origin", { amplitude: [10, 6], publish: "sway" }], ["wobble", "angles", { amplitude: 2, shape: "breath" }], ["wobble", "scale", { amplitude: [0.01, 0.01] }],
    ["cursor", "origin", { amplitude: [20, 10] }], ["lag", "angles", { from: "sway", gain: -1 }]]) {
    const on = runTemplate(name, prop, params, true), off = runTemplate(name, prop, params, false);
    for (const k of ["x", "y", "z"]) assert.ok(Number.isFinite(on.out[k]) && Math.abs(on.out[k] - on.base[k]) < 50, `${name}/${prop} ${k} runs away`);
    assert.ok(["x", "y", "z"].every(k => Math.abs(off.out[k] - off.base[k]) < 1e-6), `${name}/${prop} is not at rest when disabled`);
  }
  const g = runTemplate("gain", "alpha", { shape: "beat", variation: 0.5, base0: 0.8 }, true), g0 = runTemplate("gain", "alpha", { base0: 0.8 }, false);
  assert.ok(g.out >= 0 && g.out <= 1.3 && g0.out === 0, "gain");
  assert.strictEqual(runTemplate("scene", "alpha", { what: "parallax", base: 0.6, base0: 1 }, true).scene.cameraparallaxamount, 0.6);
  // click: shows the next target at the cursor, hides it after duration; nothing happens when disabled
  const clickSrc = SCRIPT_TEMPLATES.click.build("visible", { targets: ["a", "b"], duration: 0.2 }).code.replace(/^import .*$/gm, "").replace(/export (var|let|const|function)/g, "$1");
  const layers = { a: {}, b: {} }, timers = [], cprops = {}, cchain = { addCheckbox: p => (cprops[p.name] = p.value, cchain), addSlider: p => (cprops[p.name] = p.value, cchain), finish: () => cprops };
  const cctx = vm.createContext({ Vec3, createScriptProperties: () => cchain, thisScene: { getLayer: n => layers[n] }, engine: { setTimeout: (f, ms) => timers.push([f, ms]) } });
  vm.runInContext(clickSrc + "\nthis.__down = cursorDown; this.__props = scriptProperties;", cctx);
  cctx.__props.enabled = false; cctx.__down({ worldPosition: new Vec3(7, 9) });
  assert.ok(!layers.a.visible && !timers.length, "click is silent when disabled");
  cctx.__props.enabled = true; cctx.__down({ worldPosition: new Vec3(7, 9) }); cctx.__down({ worldPosition: new Vec3(1, 2) });
  assert.ok(layers.a.visible && layers.b.visible && layers.a.origin.x === 7 && layers.b.origin.y === 2 && timers[0][1] === 200, "click uses targets in turn");
  timers[0][0](); assert.strictEqual(layers.a.visible, false);
  assert.throws(() => SCRIPT_TEMPLATES.click.build("visible", {}), /targets/);
  assert.throws(() => SCRIPT_TEMPLATES.lag.build("angles", {}), /from/);

  // 12. performance estimate: the stored size counts (the editor pads DXT to powers of two: docs 1920x1080 DXT5 -> 2048x2048), RGBA8888 is w*h*4; the report counts a texture once and flags one shown much smaller
  assert.strictEqual(texBytes(TEX_DXT5, 2048, 2048), 2048 * 2048);
  assert.strictEqual(texBytes(TEX_DXT1, 2048, 2048), 2048 * 2048 / 2);
  assert.strictEqual(texBytes(TEX_RGBA8888, 1920, 1080), 1920 * 1080 * 4);
  const tex = await encodeTex(Buffer.alloc(1000 * 500 * 4, 255), 1000, 500);
  assert.deepStrictEqual(texHeader(tex), { flags: 2, format: TEX_RGBA8888, texW: 1000, texH: 500, imgW: 1000, imgH: 500 });
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-"));
  fs.mkdirSync(path.join(pdir, "materials")); fs.mkdirSync(path.join(pdir, "models"));
  fs.writeFileSync(path.join(pdir, "materials", "a.tex"), tex);
  fs.writeFileSync(path.join(pdir, "materials", "a.json"), JSON.stringify({ passes: [{ textures: ["a"] }] }));
  fs.writeFileSync(path.join(pdir, "models", "a.json"), JSON.stringify({ material: "materials/a.json" }));
  const layer = (id, w) => ({ id, name: "l" + id, image: "models/a.json", origin: "960 540 0", size: `${w} ${w / 2}`, scale: "1 1 1" });
  const rep = perfReport(pdir, { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [layer(1, 1000), layer(2, 1000), layer(3, 200)] }, { w: 1920, h: 1080 });
  assert.ok(/~1\.9 MB in 1 textures/.test(rep.lines.join("\n")), "same texture on three layers counts once: " + rep.lines[1]);
  assert.ok(rep.warns.length === 1 && /l3.*scale it down/.test(rep.warns[0]), "only the layer shown at 200x100 is flagged: " + rep.warns);
  assert.ok(/not an official/.test(perfReport(pdir, { objects: [] }, { w: 2000, h: 2000 }).warns[0]) && !perfReport(pdir, { objects: [] }, { w: 3840, h: 2160 }).warns.length, "resolution list");
  fs.rmSync(pdir, { recursive: true, force: true });

  // 13. capture properties: the override is visible while capturing and project.json is put back byte for byte
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-")), pjf = path.join(cdir, "project.json");
  fs.writeFileSync(pjf, '\ufeff{"general":{"properties":{"rain":{"type":"bool","value":true}}}}');
  const before = fs.readFileSync(pjf), undo = overrideProperties(cdir, { rain: false });
  assert.strictEqual(JSON.parse(fs.readFileSync(pjf, "utf8")).general.properties.rain.value, false);
  undo(); assert.ok(fs.readFileSync(pjf).equals(before), "project.json restored");
  assert.throws(() => overrideProperties(cdir, { nope: 1 }), /Unknown property "nope"/);
  fs.rmSync(cdir, { recursive: true, force: true });

  // 14. mask sources and refinements (64x64 texture: x<24 red, 24..47 blue, 48+ transparent; read the mask along y=32)
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "mask-"));
  fs.mkdirSync(path.join(mdir, "materials")); fs.mkdirSync(path.join(mdir, "models"));
  const mpx = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) { const x = i % 64; mpx.set(x < 24 ? [255, 0, 0, 255] : x < 48 ? [0, 0, 255, 255] : [0, 0, 0, 0], i * 4); }
  fs.writeFileSync(path.join(mdir, "materials", "a.tex"), await encodeTex(mpx, 64, 64));
  fs.writeFileSync(path.join(mdir, "materials", "a.json"), JSON.stringify({ passes: [{ textures: ["a"] }] }));
  fs.writeFileSync(path.join(mdir, "models", "a.json"), JSON.stringify({ material: "materials/a.json" }));
  const mlayer = { id: 1, name: "l", image: "models/a.json", origin: "32 32 0", size: "64 64", scale: "1 1 1" };
  const mctx = { dir: mdir, file: "", scene: { general: { orthogonalprojection: { width: 64, height: 64 } }, objects: [mlayer] } };
  const row = async (spec, ...xs) => { const m = await buildMask(mctx, mlayer, spec); return xs.map(x => m.rgba[(32 * 64 + x) * 4]); };
  const red = { color: { color: "#ff0000" } };
  assert.deepStrictEqual(await row(red, 10, 30, 60), [255, 0, 0], "colour key");
  assert.deepStrictEqual(await row({ from_layer: true }, 10, 30, 60), [255, 255, 0], "silhouette");
  const soft = await row({ color: { color: "#ff0000", tolerance: 0.3, softness: 0.7 } }, 30);
  assert.ok(soft[0] > 0 && soft[0] < 255, "soft colour key gives a partial level");
  assert.deepStrictEqual(await row({ color: { color: "#ff0000", tolerance: 0.3, softness: 0.7 }, threshold: 0.5 }, 10, 30), [255, 0], "threshold makes it binary");
  assert.deepStrictEqual(await row({ ...red, grow: 4 }, 26, 29), [255, 0], "grow +4 px");
  assert.deepStrictEqual(await row({ from_layer: true, grow: -4 }, 40, 46, 60), [255, 0, 0], "shrink 4 px");
  const fall = await row({ ...red, falloff: 8 }, 10, 27, 40);
  assert.ok(fall[0] === 255 && fall[1] > 50 && fall[1] < 200 && fall[2] === 0, "falloff fades with distance: " + fall);
  assert.deepStrictEqual(await row({ from_layer: true, combine: [{ op: "subtract", ...red }] }, 10, 30, 60), [0, 255, 0], "subtract");
  assert.deepStrictEqual(await row({ ...red, combine: [{ op: "add", color: { color: "#0000ff" } }] }, 10, 30, 60), [255, 255, 0], "add");
  assert.deepStrictEqual(await row({ from_layer: true, combine: [{ op: "intersect", ...red }] }, 10, 30, 60), [255, 0, 0], "intersect");
  fs.rmSync(mdir, { recursive: true, force: true });

  // 15. motion rig: chains, re-parenting without moving anything, scripts, options in order, nothing half built on a bad call
  const rdir = fs.mkdtempSync(path.join(os.tmpdir(), "rig-"));
  const solidObj = (id, name, o, size) => ({ id, name, image: "models/util/solidlayer.json", origin: o, size, scale: "1 1 1" });
  fs.writeFileSync(path.join(rdir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [solidObj(1, "fig", "960 540 0", "1920 1080"), solidObj(2, "hd", "900 780 0", "300 300")] }));
  fs.writeFileSync(path.join(rdir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
  const world = n => { const { scene } = openScene(rdir); return worldXf(scene, scene.objects.find(o => o.name === n)); };
  const [fig0, hd0] = [world("fig"), world("hd")];
  assert.throws(() => addMotionRig(rdir, { body: ["fig"], head: ["hd"] }), /head_pivot/);
  assert.throws(() => addMotionRig(rdir, { body: ["fig", "nope"] }), /not found/);
  assert.strictEqual(openScene(rdir).scene.objects.length, 2, "a bad call creates nothing");
  addMotionRig(rdir, { body: ["fig"], head: ["hd"], head_pivot: { x: 900, y: 300 } });
  const rs = openScene(rdir).scene, byName = n => rs.objects.find(o => o.name === n), parentName = n => rs.objects.find(o => o.id === byName(n).parent)?.name;
  assert.deepStrictEqual(["rig lean", "rig sway", "rig breath", "rig head", "rig head look", "rig head aim", "fig", "hd"].map(parentName),
    [undefined, "rig lean", "rig sway", "rig breath", "rig head", "rig head look", "rig breath", "rig head aim"], "chains");
  for (const [n, w0] of [["fig", fig0], ["hd", hd0]]) { const w1 = world(n); assert.ok(["x", "y", "sx", "sy", "rot"].every(k => Math.abs(w1[k] - w0[k]) < 1e-3), `${n} stays where it was`); }
  assert.strictEqual(JSON.stringify(rs).split('"script":"').length - 1, 10, "ten scripts on the chain");
  const rprops = JSON.parse(fs.readFileSync(path.join(rdir, "project.json"), "utf8")).general.properties;
  for (const k of ["anim_master", "anim_speed", "g_rig", "rig_look", "rig_look_amt", "rig_sway", "rig_breath", "rig_head_amt"]) assert.ok(rprops[k], `property ${k}`);
  assert.ok(rprops.anim_master.order < rprops.rig_look.order, "shared switches come first in the panel");
  assert.throws(() => addMotionRig(rdir, { body: ["fig"] }), /already exists/);
  fs.rmSync(rdir, { recursive: true, force: true });

  // 16. backups (own process: the paths come from WE_INSTALL_PATH at import time): restore, "latest" is the newest, delete keeps a copy
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "we-")), pdir2 = path.join(wdir, "projects", "myprojects", "foo");
  fs.mkdirSync(pdir2, { recursive: true }); fs.writeFileSync(path.join(pdir2, "a.txt"), "1");
  const R = n => JSON.stringify(path.resolve(__dirname, dist, n)), A = JSON.stringify(path.join(pdir2, "a.txt"));
  const bout = require("child_process").execFileSync(process.execPath, ["-e", `
    const b = require(${R("tools/backup")}), d = require(${R("tools/delete")}), fs = require("fs"), f = ${A};
    const one = b.backupProject("foo", "one").id; fs.writeFileSync(f, "2");
    b.restoreProject("foo", one); console.log(fs.readFileSync(f, "utf8"));
    console.log(b.restoreProject("foo").split("\\n").length);
    fs.writeFileSync(f, "3"); d.deleteWallpaper("foo"); console.log(fs.existsSync(f));
    b.restoreProject("foo", "latest"); console.log(fs.readFileSync(f, "utf8"));
  `], { env: { ...process.env, WE_INSTALL_PATH: wdir } }).toString().trim().split(/\r?\n/);
  assert.deepStrictEqual(bout, ["1", "4", "false", "3"], "backup / restore / delete: " + bout);
  fs.rmSync(wdir, { recursive: true, force: true });
  // 17. animated texture: frames -> one sprite sheet, TEXS flag, .tex-json sequence (WE rebuilds the .tex from it), layer = ONE frame, bad input refused
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "spr-")), fr = async (n, w, h) => { const f = path.join(sdir, n + ".png"); await sharp({ create: { width: w, height: h, channels: 4, background: "#f00" } }).png().toFile(f); return f; };
  const f3 = [await fr("a", 8, 4), await fr("b", 8, 4), await fr("c", 8, 4)];
  const spr = await importSprite(sdir, { frames: f3, sprite: { fps: 10 } }, "anim");
  assert.deepStrictEqual([spr.w, spr.h], [8, 4], "layer is one frame big");
  const sbuf = fs.readFileSync(path.join(sdir, "materials", spr.base + ".tex"));
  assert.ok(texHeader(sbuf).flags & 4, "sprite flag");
  const sone = await texToRgba(sbuf);
  assert.deepStrictEqual([sone.w, sone.h], [8, 4], "texToRgba returns the first frame");
  const sj = JSON.parse(fs.readFileSync(path.join(sdir, "materials", spr.base + ".tex-json"), "utf8"));
  assert.ok(sj.spritesheet && sj.spritesheetsequences[0].frames === 3 && Math.abs(sj.spritesheetsequences[0].duration - 0.3) < 1e-9, "tex-json sequence");
  await assert.rejects(importSprite(sdir, { frames: [f3[0], await fr("d", 9, 4)] }, "bad"), /same size/);
  await assert.rejects(importSprite(sdir, { image: f3[0], sprite: { cols: 3, rows: 1 } }, "bad2"), /not divisible/);
  fs.rmSync(sdir, { recursive: true, force: true });

  // 18. lights: calibrated in the engine (angles, controlpoint, lightconfig, LIGHTING combo on the material)
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), "lit-"));
  fs.mkdirSync(path.join(ldir, "models")); fs.mkdirSync(path.join(ldir, "materials"));
  fs.writeFileSync(path.join(ldir, "models", "a.json"), JSON.stringify({ material: "materials/a.json" }));
  fs.writeFileSync(path.join(ldir, "materials", "a.json"), JSON.stringify({ passes: [{ shader: "genericimage4", combos: {}, textures: ["a"] }] }));
  fs.writeFileSync(path.join(ldir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [{ id: 1, name: "bg", image: "models/a.json", origin: "960 540 0", size: "100 100", scale: "1 1 1" }] }));
  fs.writeFileSync(path.join(ldir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
  const lm = () => JSON.parse(fs.readFileSync(path.join(ldir, "materials", "a.json"), "utf8")).passes[0].combos.LIGHTING;
  addLight(ldir, { type: "spot", x: 100, y: 100, height: 100, aim: { x: 200, y: 100 } });
  addLight(ldir, { type: "point", x: 10, y: 20 });
  addLight(ldir, { type: "tube", x: 100, y: 100, to: { x: 150, y: 60 } });
  const ls = openScene(ldir).scene, lobj = k => ls.objects.find(o => o.light === k);
  const ang = lobj("lspot").angles.split(" ").map(Number);
  assert.ok(Math.abs(ang[1] - Math.PI / 4) < 1e-4 && Math.abs(ang[2]) < 1e-4, "spot aimed 100 px to the right from 100 up: pitch 45deg, yaw 0: " + ang);
  assert.strictEqual(lobj("lspot").origin, "100.00000 980.00000 100.00000", "canvas y is flipped, z is the height");
  assert.strictEqual(lobj("ltube").controlpoint, "50.00000 40.00000 0.00000", "tube end is an offset, y up");
  assert.deepStrictEqual(ls.general.lightconfig, { spot: 1, point: 1, tube: 1 }, "lightconfig counts per type");
  assert.strictEqual(lm(), 1, "image material is lit");
  addLight(ldir, { type: "spot", x: 1, y: 1 }); assert.ok(Math.abs(openScene(ldir).scene.objects.filter(o => o.light === "lspot")[1].angles.split(" ")[1] - Math.PI / 2) < 1e-4, "no aim = straight down");
  updateLayer(ldir, "bg", { lighting: false }); assert.strictEqual(lm(), 0, "lighting off again");
  assert.throws(() => addLight(ldir, { height: 0 }), /height/);
  fs.rmSync(ldir, { recursive: true, force: true });
  // 19. scripts: every template compiles, audio / events / media are wired, supportsaudioprocessing follows the scene
  const adir = fs.mkdtempSync(path.join(os.tmpdir(), "aud-"));
  const sobj = (id, name) => ({ id, name, image: "models/util/solidlayer.json", origin: "960 540 0", size: "100 100", scale: "1 1 1" });
  fs.writeFileSync(path.join(adir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [sobj(1, "a"), sobj(2, "b"), sobj(3, "c")] }));
  fs.writeFileSync(path.join(adir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
  const codeOf = (n, prop) => openScene(adir).scene.objects.find(o => o.name === n)[prop].script;
  const compiles = (n, prop) => { new Function(codeOf(n, prop).replace(/^export /gm, "")); return codeOf(n, prop); }; // throws on a syntax error
  const pj = () => JSON.parse(fs.readFileSync(path.join(adir, "project.json"), "utf8")).general;
  assert.ok(!pj().supportsaudioprocessing && !usesAudio(JSON.stringify(openScene(adir).scene)), "no audio yet");
  addScript(adir, "a", { property: "alpha", template: "audio", band: "treble" });
  assert.ok(/registerAudioBuffers/.test(compiles("a", "alpha")) && /LO = 11, HI = 15/.test(codeOf("a", "alpha")), "audio on a number, treble = bins 11-15");
  assert.strictEqual(pj().supportsaudioprocessing, true, "an audio script switches supportsaudioprocessing on");
  addScript(adir, "a", { property: "origin", template: "audio" }); compiles("a", "origin");
  addScript(adir, "a", { property: "scale", template: "audio", band: [2, 5] }); assert.ok(/LO = 2, HI = 5/.test(compiles("a", "scale")));
  assert.throws(() => addScript(adir, "b", { property: "visible", template: "audio" }), /does not fit/);
  assert.throws(() => addScript(adir, "b", { property: "alpha", template: "audio", band: "xx" }), /band must be/);
  assert.throws(() => addScript(adir, "b", { property: "alpha", template: "audio", band: [3, 20] }), /bins/);
  addScript(adir, "b", { property: "text", template: "media" }); assert.ok(/mediaPropertiesChanged/.test(compiles("b", "text")));
  addScript(adir, "b", { property: "color", template: "media", which: "text" }); assert.ok(/textColor/.test(compiles("b", "color")));
  assert.throws(() => addScript(adir, "b", { property: "color", template: "media", which: "nope" }), /which must be/);
  assert.throws(() => addScript(adir, "c", { property: "visible", template: "event" }), /needs targets/);
  addScript(adir, "c", { property: "visible", template: "event", on: "pop", targets: "b", emit: ["a"], sounds: "s" }); assert.ok(/animationEvent/.test(compiles("c", "visible")));
  addScript(adir, "b", { property: "visible", template: "emit", count: 5 }); compiles("b", "visible");
  addScript(adir, "b", { property: "origin", template: "wobble" }); compiles("b", "origin");
  addScript(adir, "b", { property: "angles", template: "cursor" }); compiles("b", "angles");
  addScript(adir, "b", { property: "scale", template: "lag", from: "x" }); compiles("b", "scale");
  addScript(adir, "b", { property: "brightness", template: "gain", shape: "beat" }); compiles("b", "brightness");
  addScript(adir, "b", { property: "alpha", template: "scene" }); compiles("b", "alpha");
  addScript(adir, "b", { property: "visible", template: "click", targets: "a" }); compiles("b", "visible");
  // animation events: seconds -> frames of the animation (fps = frames per cycle / period)
  animateLayer(adir, "c", { property: "origin", amplitude: [0, 0], period: 4, events: [{ t: 1, name: "pop" }, { t: 4, name: "end" }] });
  const opt = openScene(adir).scene.objects.find(o => o.name === "c").origin.animation.options;
  assert.deepStrictEqual(opt.events.map(e => e.name + "@" + e.frame / opt.fps), ["pop@1", "end@4"], "events land on their second");
  assert.throws(() => animateLayer(adir, "c", { property: "origin", period: 4, events: [{ t: 5, name: "late" }] }), /inside the animation/);
  fs.rmSync(adir, { recursive: true, force: true });
  // 20. copy_example_layer: subtree + dependencies, fresh ids, bindings flattened, never overwrites different files
  const xdir = fs.mkdtempSync(path.join(os.tmpdir(), "exs-")), ydir = fs.mkdtempSync(path.join(os.tmpdir(), "exd-"));
  const put = (root, rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
  const grp = { id: 10, name: "g", origin: "100 100 0" };
  const kid = { id: 11, name: "kid", parent: 10, image: "models/a.json", origin: "5 5 0", size: "10 10", visible: { user: "vis", value: false }, effects: [{ id: 20, file: "effects/x/effect.json", passes: [{ id: 21, textures: [null, "masks/m"], constantshadervalues: { amount: { user: "p", value: 3 } } }] }] };
  put(xdir, "project.json", JSON.stringify({ type: "scene", file: "scene.json", title: "Src", general: { properties: {} } }));
  put(xdir, "scene.json", JSON.stringify({ general: { orthogonalprojection: { width: 100, height: 100 } }, objects: [grp, kid, { id: 12, name: "other", image: "models/b.json" }] }));
  put(xdir, "models/a.json", JSON.stringify({ material: "materials/a.json" })); put(xdir, "materials/a.json", JSON.stringify({ passes: [{ shader: "genericimage4", textures: ["a"] }] }));
  put(xdir, "materials/a.tex", "TEX"); put(xdir, "materials/masks/m.tex", "MASK");
  put(xdir, "effects/x/effect.json", JSON.stringify({ passes: [{ material: "materials/effects/x.json" }] })); put(xdir, "materials/effects/x.json", JSON.stringify({ passes: [{ shader: "effects/x" }] }));
  put(xdir, "shaders/effects/x.frag", '#include "common.h"\nvoid main(){}'); put(xdir, "shaders/common.h", "// h");
  put(xdir, "models/b.json", JSON.stringify({ material: "materials/b.json" })); put(xdir, "materials/b.json", "{}");
  put(ydir, "project.json", JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
  put(ydir, "scene.json", JSON.stringify({ general: { orthogonalprojection: { width: 100, height: 100 } }, objects: [{ id: 1, name: "mine" }, { id: 2, name: "mine2" }] }));
  assert.match(copyExampleLayer({ source: xdir }), /3 layers/, "inspect lists the scene");
  assert.match(copyExampleLayer({ source: xdir, layer: "kid" }), /effect #0 x: .*"amount":\{"user":"p","value":3\}/, "inspect shows effect parameter values");
  copyExampleLayer({ source: xdir, layer: "g", project: ydir, name: "copy" });
  const ys = openScene(ydir).scene, cg = ys.objects.find(o => o.name === "copy"), ck = ys.objects.find(o => o.name === "kid");
  assert.strictEqual(ys.objects.length, 4, "group + child added, the unrelated layer is not");
  assert.ok(cg.id > 2 && ck.id > 2 && cg.id !== ck.id && ck.parent === cg.id, "fresh ids, child follows its parent");
  assert.ok(!JSON.stringify(ys).includes('"user"'), "bindings flattened");
  assert.strictEqual(ck.visible, false); assert.strictEqual(ck.effects[0].passes[0].constantshadervalues.amount, 3);
  assert.ok(new Set(JSON.stringify(ys).match(/"id":(\d+)/g)).size === 2 + 2 + 2, "object / effect / pass ids all distinct");
  const got = f => fs.existsSync(path.join(ydir, f));
  assert.ok(["models/a.json", "materials/a.json", "materials/a.tex", "materials/masks/m.tex", "effects/x/effect.json", "materials/effects/x.json", "shaders/effects/x.frag", "shaders/common.h"].every(got), "dependencies copied");
  assert.ok(!got("models/b.json") && !got("materials/b.json"), "unrelated files stay behind");
  copyExampleLayer({ source: xdir, layer: "g", project: ydir }); // same files again: fine
  fs.writeFileSync(path.join(ydir, "materials", "a.tex"), "DIFFERENT");
  assert.throws(() => copyExampleLayer({ source: xdir, layer: "g", project: ydir }), /different files/);
  assert.strictEqual(openScene(ydir).scene.objects.length, 6, "a refused copy adds nothing");
  // openPkg: read one file out of a .pkg
  const pk = path.join(xdir, "t.pkg"), body = Buffer.from("hello"), nm = Buffer.from("a.txt");
  const hd = Buffer.alloc(4 + 8 + 4 + 4 + nm.length + 8); let po = 0; hd.writeInt32LE(8, po); po += 4; hd.write("PKGV0001", po); po += 8; hd.writeInt32LE(1, po); po += 4; hd.writeInt32LE(nm.length, po); po += 4; nm.copy(hd, po); po += nm.length; hd.writeInt32LE(0, po); po += 4; hd.writeInt32LE(body.length, po);
  fs.writeFileSync(pk, Buffer.concat([hd, body]));
  assert.strictEqual(openPkg(pk).read("a.txt").toString(), "hello"); assert.strictEqual(openPkg(pk).read("nope"), undefined);
  fs.rmSync(xdir, { recursive: true, force: true }); fs.rmSync(ydir, { recursive: true, force: true });
  // 21. video: mp4 size from the tkhd box, .tex wrapper (flags 32 + 2, the mp4 right behind the headers; byte-identical to an editor-made one when compared by hand)
  const box = (type, ...kids) => { const body = Buffer.concat(kids), h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
  const wh = Buffer.alloc(8); wh.writeUInt32BE(1280 * 65536, 0); wh.writeUInt32BE(720 * 65536, 4);
  const mp4 = Buffer.concat([box("ftyp", Buffer.from("isom")), box("free"), box("moov", box("trak", box("tkhd", Buffer.alloc(76), wh)))]);
  assert.deepStrictEqual(mp4Size(mp4), { w: 1280, h: 720 });
  assert.throws(() => mp4Size(Buffer.from("not an mp4 at all")), /MP4/);
  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), "vid-")), vfile = path.join(vdir, "in.mp4");
  fs.writeFileSync(vfile, mp4);
  const vid = importVideo(vdir, vfile, "clip");
  assert.deepStrictEqual([vid.w, vid.h], [1280, 720]);
  const vtex = fs.readFileSync(path.join(vdir, "materials", vid.base + ".tex"));
  assert.strictEqual(texHeader(vtex).flags, 34, "video + clamp flags");
  assert.ok(vtex.subarray(vtex.length - mp4.length).equals(mp4), "the mp4 sits at the end of the .tex");
  assert.ok(fs.readFileSync(path.join(vdir, "materials", vid.base + ".mp4")).equals(mp4), "the mp4 is copied next to the .tex");
  assert.throws(() => importVideo(vdir, path.join(vdir, "nope.mp4"), "x"), /not found/);
  fs.rmSync(vdir, { recursive: true, force: true });
  // 22. v4.10 additions: timeline options, HDR bloom, RGB source, texture property, new script templates, particle scripts, video project
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "v410-"));
  fs.mkdirSync(path.join(tdir, "models")); fs.mkdirSync(path.join(tdir, "materials"));
  fs.writeFileSync(path.join(tdir, "models", "a.json"), JSON.stringify({ material: "materials/a.json" }));
  fs.writeFileSync(path.join(tdir, "materials", "a.json"), JSON.stringify({ passes: [{ shader: "genericimage4", combos: {}, textures: ["a"] }] }));
  const tobj = (id, name, extra) => ({ id, name, origin: "960 540 0", size: "100 100", scale: "1 1 1", ...extra });
  fs.writeFileSync(path.join(tdir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [
    tobj(1, "a", { image: "models/a.json" }), tobj(2, "s", { image: "models/util/solidlayer.json" }), tobj(3, "p", { particle: "particles/x.json" })] }));
  fs.writeFileSync(path.join(tdir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
  const T = () => openScene(tdir).scene, TO = n => T().objects.find(o => o.name === n);
  // timeline: linear keys have no handles, name / startpaused land in options, join = shared timeline (children here, parent there), clearing the master frees the child
  animateLayer(tdir, "a", { property: "origin", amplitude: [0, 10], period: 4, linear: true, name: "float", start_paused: true });
  const oa = TO("a").origin.animation;
  assert.ok(oa.c1.every(k => !k.front.enabled && !k.back.enabled && !k.lockangle), "linear keyframes: no tangent handles");
  assert.strictEqual(oa.options.name, "float"); assert.strictEqual(oa.options.startpaused, true);
  animateLayer(tdir, "a", { property: "alpha", amplitude: 0.2, period: 8, join: "origin" });
  assert.deepStrictEqual(TO("a").origin.animation.options.children, [{ key: "alpha" }]);
  assert.deepStrictEqual(TO("a").alpha.animation.options.parent, { key: "origin" });
  assert.strictEqual(TO("a").alpha.animation.options.length, oa.options.length, "joined: same length");
  assert.throws(() => animateLayer(tdir, "a", { property: "scale", amplitude: 0.1, join: "color" }), /needs its own animation/);
  animateLayer(tdir, "a", { property: "origin", clear: true });
  assert.ok(!TO("a").alpha.animation, "clearing the master frees the joined property");
  // HDR bloom keys
  sceneSettings(tdir, { bloom: { hdr: { strength: 3, scatter: 1.2, threshold: 0.8, smoothing: 0.2, iterations: 6 } } });
  const tg = T().general;
  assert.deepStrictEqual([tg.bloomhdrstrength, tg.bloomhdrscatter, tg.bloomhdrthreshold, tg.bloomhdrfeather, tg.bloomhdriterations], [3, 1.2, 0.8, 0.2, 6]);
  // RGB source flag
  updateLayer(tdir, "s", { led: true }); assert.strictEqual(TO("s").ledsource, true);
  // texture property: scenetexture in project.json + usertextures on the material pass; refuses fakeLayers it cannot bind
  updateLayer(tdir, "a", { texture_property: "pic" });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tdir, "materials", "a.json"), "utf8")).passes[0].usertextures, ["pic"]);
  const tp = JSON.parse(fs.readFileSync(path.join(tdir, "project.json"), "utf8")).general.properties.pic;
  assert.ok(tp.type === "scenetexture" && tp.value === "", "texture property type");
  assert.throws(() => updateLayer(tdir, "s", { texture_property: "x" }), /cannot take a texture property/);
  // scripts: run them against fake globals
  const csp = () => { const o = {}, b = { addCheckbox: p => (o[p.name] = p.value, b), addSlider: p => (o[p.name] = p.value, b), finish: () => o }; return b; };
  const store = {}, fakeLayers = { x: { visible: true }, y: { visible: true } };
  const boot = (tpl, prop, a, pre = {}) => {
    addScript(tdir, "a", { property: prop, template: tpl, ...a });
    const code = TO("a")[prop].script.replace(/^export /gm, "");
    const g = { createScriptProperties: csp, engine: { frametime: 0.1, runtime: 0, openUserShortcut: k => (store.opened = k) }, localStorage: { get: k => store[k], set: (k, v) => (store[k] = v) }, thisScene: { getLayer: n => fakeLayers[n] } };
    const H = new Function(...Object.keys(g), `${code}\nvar H = { scriptProperties: scriptProperties }; ["init", "update", "cursorEnter", "cursorLeave", "cursorClick"].forEach(function (n) { try { H[n] = eval(n); } catch (e) {} }); return H;`)(...Object.values(g));
    if (H.init) H.init(1);
    return H;
  };
  const at = h => { const s = boot("daytime", "alpha", { hours: [18, 6], fade: 1 }); s.scriptProperties.hour = h; return s.update(1); };
  assert.deepStrictEqual([12, 23, 3].map(at), [0, 1, 1], "daytime: off at noon, on at night, across midnight");
  assert.ok(Math.abs(at(18.5) - 0.5) < 1e-9 && Math.abs(at(5.5) - 0.5) < 1e-9, "daytime: half way through the fade at both ends");
  assert.throws(() => addScript(tdir, "a", { property: "alpha", template: "daytime", hours: [18, 30] }), /hours/);
  const hv = boot("hover", "alpha", {}); hv.cursorEnter(); for (let i = 0; i < 40; i++) hv.update(1);
  assert.ok(hv.update(1) > 0.99, "hover: reaches 1 over the layer"); hv.cursorLeave(); for (let i = 0; i < 40; i++) hv.update(1);
  assert.ok(Math.abs(hv.update(1) - 0.6) < 0.01, "hover: back to rest");
  assert.throws(() => addScript(tdir, "a", { property: "alpha", template: "toggle" }), /needs targets/);
  const tg1 = boot("toggle", "alpha", { targets: ["x", "y"], key: "k" }); tg1.update(1);
  assert.ok(fakeLayers.x.visible && fakeLayers.y.visible, "toggle: shown at first");
  tg1.cursorClick(); assert.ok(!fakeLayers.x.visible && !fakeLayers.y.visible && store.k === false, "toggle: click hides both and remembers");
  const tg2 = boot("toggle", "alpha", { targets: ["x", "y"], key: "k" }); fakeLayers.x.visible = true; tg2.update(1);
  assert.ok(!fakeLayers.x.visible, "toggle: the stored state wins after a restart");
  boot("launch", "alpha", { shortcut: "app1" }).cursorClick(); assert.strictEqual(store.opened, "app1");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tdir, "project.json"), "utf8")).general.properties.app1.type, "usershortcut");
  // particle multipliers live in instanceoverride
  addScript(tdir, "p", { property: "rate", template: "gain", shape: "sine" });
  assert.ok(TO("p").instanceoverride.rate.script && TO("p").instanceoverride.rate.value === 1, "particle rate script");
  assert.throws(() => addScript(tdir, "a", { property: "rate", template: "gain" }), /not a particle system/);
  fs.rmSync(tdir, { recursive: true, force: true });
  // video wallpaper project (own process: WE_INSTALL_PATH is read at import time)
  const vwe = fs.mkdtempSync(path.join(os.tmpdir(), "vwe-")), vsrc = path.join(vwe, "clip.mp4"); fs.writeFileSync(vsrc, "not really a video");
  fs.mkdirSync(path.join(vwe, "projects", "myprojects"), { recursive: true });
  const vout = require("child_process").execFileSync(process.execPath, ["-e", `
    require(${JSON.stringify(path.resolve(__dirname, dist, "tools/scene"))}).createVideoWallpaper({ name: "My Clip", video: ${JSON.stringify(vsrc)}, tags: ["Anime"] }).then(r => console.log(r.split("\\n")[0]));
  `], { env: { ...process.env, WE_INSTALL_PATH: vwe } }).toString();
  const vp = path.join(vwe, "projects", "myprojects", "my_clip"), vj = JSON.parse(fs.readFileSync(path.join(vp, "project.json"), "utf8"));
  assert.ok(/Created VIDEO/.test(vout) && vj.type === "video" && vj.file === "my_clip.mp4" && fs.existsSync(path.join(vp, "my_clip.mp4")) && fs.existsSync(path.join(vp, "preview.jpg")), "video project: " + vout);
  fs.rmSync(vwe, { recursive: true, force: true });
  // 23. block compression, 2-channel textures, normal maps, material, optimize_textures
  {
  const { heightToNormal, smoothHeight, setMaterial } = require(dist + "tools/material");
  const { optimizeTextures } = require(dist + "tools/optimize");
  const { validateProject } = require(dist + "tools/preview");
  const { parseTex, TEX_RG88 } = require(dist + "tex");
  const gw = 70, gh = 50, gpx = Buffer.alloc(gw * gh * 4);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) gpx.set([x * 3, y * 4, 128, x < 50 ? 255 : 0], (y * gw + x) * 4);
  for (const fmt of ["dxt5", "dxt1"]) {
    const src = Buffer.from(gpx); if (fmt === "dxt1") for (let i = 3; i < src.length; i += 4) src[i] = 255;
    const buf = await encodeTex(src, gw, gh, { format: fmt }), hd = parseTex(buf), back = await texToRgba(buf);
    assert.deepStrictEqual([hd.texW, hd.texH, hd.imgW, hd.imgH], [80, 64, gw, gh], fmt + ": stored size is padded to 16, real size kept");
    assert.strictEqual(hd.format, fmt === "dxt5" ? TEX_DXT5 : TEX_DXT1);
    let sum = 0, n = 0;
    for (let i = 0; i < gw * gh; i++) {
      assert.strictEqual(back.rgba[i * 4 + 3], src[i * 4 + 3], fmt + ": alpha exact");
      if (src[i * 4 + 3]) for (let c = 0; c < 3; c++) { sum += Math.abs(back.rgba[i * 4 + c] - src[i * 4 + c]); n++; }
    }
    assert.ok(sum / n < 8, `${fmt}: mean colour error ${(sum / n).toFixed(1)}`);
  }
  const rg = await texToRgba(await encodeTex(gpx, gw, gh, { format: "rg88", bleed: false }));
  assert.ok(rg.rgba.every((v, i) => i % 4 === 3 ? v === 255 : i % 4 === 2 ? v === 0 : v === gpx[i]), "rg88 round trip keeps red + green");
  const flatN = heightToNormal(Buffer.alloc(64, 100), 8, 8, 3);
  assert.deepStrictEqual([...flatN.subarray(0, 4)], [128, 128, 255, 255], "flat height = straight up normal");
  const ramp = (f, flip) => heightToNormal(Buffer.from(Array.from({ length: 64 }, (_, i) => f(i % 8, i >> 3) * 10)), 8, 8, 3, flip).subarray((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 3);
  assert.ok(ramp(x => x)[0] < 128 && ramp(x => x)[1] === 128, "rising to the right tilts the normal left (red < 128)");
  assert.ok(ramp((x, y) => y)[1] > 128 && ramp((x, y) => y, true)[1] < 128, "rising downwards: green > 128, flip_y inverts it");
  assert.strictEqual((await smoothHeight(Buffer.alloc(64, 7), 8, 8, 1.5)).length, 64, "smoothHeight keeps one channel");
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "mat-"));
  fs.mkdirSync(path.join(mdir, "models")); fs.mkdirSync(path.join(mdir, "materials"));
  fs.writeFileSync(path.join(mdir, "models", "a.json"), JSON.stringify({ material: "materials/a.json" }));
  const mat = () => JSON.parse(fs.readFileSync(path.join(mdir, "materials", "a.json"), "utf8")).passes[0];
  fs.writeFileSync(path.join(mdir, "materials", "a.json"), JSON.stringify({ passes: [{ shader: "genericimage4", combos: {}, textures: ["a"] }] }));
  fs.writeFileSync(path.join(mdir, "materials", "a.tex"), await encodeTex(gpx, gw, gh, {}));
  fs.writeFileSync(path.join(mdir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [{ id: 1, name: "a", image: "models/a.json", origin: "960 540 0", size: "70 50", scale: "1 1 1" }] }));
  fs.writeFileSync(path.join(mdir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
  await assert.rejects(setMaterial(mdir, "a", { reflection: true }), /needs a normal map/);
  await setMaterial(mdir, "a", { normal_map: "auto", metallic: 1, reflection: true });
  assert.deepStrictEqual([mat().combos.NORMALMAP, mat().combos.REFLECTION, mat().textures, mat().constantshadervalues.metallic], [1, 1, ["a", "a_normal"], 1]);
  assert.strictEqual(parseTex(fs.readFileSync(path.join(mdir, "materials", "a_normal.tex"))).format, TEX_RG88, "normal map is a 2-channel texture");
  assert.ok(!/error/i.test(validateProject(mdir).split("\n").filter(l => /reflection|material texture/.test(l)).join("")), "valid material passes validate");
  const bad = mat(); delete bad.combos.NORMALMAP; fs.writeFileSync(path.join(mdir, "materials", "a.json"), JSON.stringify({ passes: [bad] }));
  assert.ok(/reflection needs a normal map/.test(validateProject(mdir)), "validate flags REFLECTION without NORMALMAP");
  await setMaterial(mdir, "a", { clear: true });
  assert.deepStrictEqual([mat().textures, mat().combos], [["a"], {}], "clear restores the plain material");
  assert.ok(/DXT5/.test(await optimizeTextures(mdir, { min_size: 16 })) && parseTex(fs.readFileSync(path.join(mdir, "materials", "a.tex"))).format === TEX_DXT5, "optimize_textures re-encodes as DXT5 (it has alpha)");
  assert.ok(/Nothing to compress/.test(await optimizeTextures(mdir, { min_size: 16 })), "a compressed texture is left alone");
  fs.rmSync(mdir, { recursive: true, force: true });
  }
  // 24. create_effect: the same file layout the editor writes, controls the effect parser reads back, nothing half written on a bad call
  {
    const { createEffect } = require(dist + "tools/neweffect");
    const { loadEffect } = require(dist + "effects"), { validateProject } = require(dist + "tools/preview");
    const edir = fs.mkdtempSync(path.join(os.tmpdir(), "fx-"));
    fs.writeFileSync(path.join(edir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [] }));
    fs.writeFileSync(path.join(edir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
    const out = createEffect(edir, { name: "desat", params: [{ key: "amount", default: 1, range: [0, 1] }, { key: "tint", type: "color", default: "#ff0000" }, { key: "at", type: "vec2", default: [0.5, 0.25] }], code: "albedo.rgb = mix(albedo.rgb, CAST3(dot(vec3(0.11, 0.59, 0.3), albedo.rgb)), u_amount);" });
    const ej = JSON.parse(fs.readFileSync(path.join(edir, "effects", "desat", "effect.json"), "utf8"));
    assert.deepStrictEqual([ej.passes[0].material, ej.editable, ej.group, ej.replacementkey], ["materials/effects/desat.json", true, "localeffects", "desat"]);
    assert.ok(ej.dependencies.every(d => fs.existsSync(path.join(edir, d))), "every dependency exists");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(edir, "materials", "effects", "desat.json"), "utf8")).passes[0].shader, "effects/desat");
    const fi = loadEffect("desat", edir);
    assert.deepStrictEqual(fi.params.map(p => [p.key, p.type, JSON.stringify(p.default), p.range && p.range.join()]), [["amount", "float", "1", "0,1"], ["tint", "color", '"1.00000 0.00000 0.00000"', undefined], ["at", "vec2", '"0.5 0.25"', undefined]]);
    assert.ok(fi.samplers.some(s => s.role === "opacity" && s.slot === 1), "the opacity mask slot is there");
    assert.ok(/u_amount/.test(fs.readFileSync(path.join(edir, "shaders", "effects", "desat.frag"), "utf8")) && /Wallpaper|desat/.test(out));
    // the validator catches a material whose shader name does not match the files
    const mj = path.join(edir, "materials", "effects", "desat.json"), mm = JSON.parse(fs.readFileSync(mj, "utf8")); mm.passes[0].shader = "effects/desatt"; fs.writeFileSync(mj, JSON.stringify(mm));
    const sc = JSON.parse(fs.readFileSync(path.join(edir, "scene.json"), "utf8"));
    sc.objects.push({ id: 1, name: "x", origin: "960 540 0", size: "10 10", scale: "1 1 1", image: "models/util/solidlayer.json", effects: [{ file: "effects/desat/effect.json", id: 2, name: "desat", passes: [{ id: 3 }] }] });
    fs.writeFileSync(path.join(edir, "scene.json"), JSON.stringify(sc));
    assert.ok(/shaders\/effects\/desatt\.frag missing/.test(validateProject(edir)), "validate: material shader / file name mismatch");
    // refusals, and rewriting
    assert.throws(() => createEffect(edir, { name: "tint" }), /built-in/);
    assert.throws(() => createEffect(edir, { name: "Bad Name" }), /lower-case/);
    assert.throws(() => createEffect(edir, { name: "other", params: [{ key: "x", range: [2, 1] }] }), /min < max/);
    assert.ok(!fs.existsSync(path.join(edir, "effects", "other")), "a bad call writes nothing");
    createEffect(edir, { name: "desat", params: [{ key: "gain", default: 2 }], code: "albedo.rgb *= u_gain;" });
    assert.deepStrictEqual(loadEffect("desat", edir).params.map(p => p.key), ["gain"], "same name rewrites the shader (and the cached description)");
    fs.writeFileSync(path.join(edir, "effects", "desat", "effect.json"), JSON.stringify({ passes: [] }));
    assert.throws(() => createEffect(edir, { name: "desat" }), /not made by create_effect/);
    fs.rmSync(edir, { recursive: true, force: true });
  }
  // 25. create_particles: WE's own file layout (ids, units of the colour keys, control points, child systems), placed in the scene, validated
  {
    const { createParticles } = require(dist + "tools/newparticles"), { validateProject } = require(dist + "tools/preview");
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
    fs.mkdirSync(path.join(pdir, "materials"));
    fs.writeFileSync(path.join(pdir, "materials", "dot.tex"), "x");
    fs.writeFileSync(path.join(pdir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [] }));
    fs.writeFileSync(path.join(pdir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
    const out = await createParticles(pdir, {
      name: "burst", x: 960, y: 540, texture: "dot", blending: "normal", maxcount: 40,
      initializer: [{ name: "colorrandom", min: "#ff0000", max: [0, 0, 1] }, { name: "velocityrandom", min: [-1, -2, 0], max: [1, 2, 0] }],
      operator: [{ name: "colorchange", startvalue: "#ff0000", endvalue: "#0000ff" }, { name: "controlpointattract", controlpoint: 1, scale: -500, threshold: 100 }],
      control_points: { 1: { pointer: true }, 2: { offset: [10, 20, 0], worldspace: true } },
      children: [{ type: "eventdeath", maxcount: 5, set_control_points: 2, system: { emitter: [{ name: "sphererandom", rate: 0, instantaneous: 20 }] } }],
    });
    const pj = JSON.parse(fs.readFileSync(path.join(pdir, "particles", "burst.json"), "utf8"));
    assert.deepStrictEqual([pj.maxcount, pj.material, pj.renderer[0].name, pj.emitter[0].name], [40, "materials/particle/burst.json", "sprite", "sphererandom"], "defaults fill the empty categories");
    assert.deepStrictEqual([pj.initializer[0].min, pj.initializer[0].max, pj.initializer[1].min], ["255 0 0", "0 0 255", "-1 -2 0"], "colorrandom is 0-255, vectors are strings");
    assert.deepStrictEqual([pj.operator[0].startvalue, pj.operator[0].endvalue], ["1.00000 0.00000 0.00000", "0.00000 0.00000 1.00000"], "colorchange is 0-1");
    const ids = [...pj.renderer, ...pj.initializer, ...pj.emitter, ...pj.operator, ...pj.children].map(c => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, "ids are unique");
    assert.deepStrictEqual([pj.controlpoint.length, pj.controlpoint[1].flags, pj.controlpoint[1].locktopointer, pj.controlpoint[2].flags, pj.controlpoint[2].offset], [8, 1, true, 2, "10 20 0"], "control points: pointer / worldspace");
    assert.deepStrictEqual([pj.children[0].name, pj.children[0].type, pj.children[0].flags, pj.children[0].controlpointstartindex], ["particles/burst_c1.json", "eventdeath", 1, 2]);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pdir, "materials", "particle", "burst.json"), "utf8")).passes[0].blending, "normal");
    assert.ok(/particle system \[1\] "burst" \(from scratch\)/.test(out), out);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pdir, "scene.json"), "utf8")).objects[0].particle, "particles/burst.json");
    assert.ok(/No errors/.test(validateProject(pdir)), "a created system validates");
    await assert.rejects(createParticles(pdir, { name: "bad", operator: [{ name: "movment" }] }), /not a Wallpaper Engine component/);
    await assert.rejects(createParticles(pdir, { name: "bad", texture: "nope/none" }), /not found/);
    await assert.rejects(createParticles(pdir, { name: "bad", control_points: { 9: {} } }), /0\.\.7/);
    await assert.rejects(createParticles(pdir, { name: "bad", children: [{ type: "eventdeath" }] }), /either file/);
    assert.ok(!fs.existsSync(path.join(pdir, "particles", "bad.json")), "a bad call writes no particle file");
    assert.ok((await createParticles(pdir, { name: "burst" })).includes("particles/burst_2.json"), "same name again = a new file, the first one stays");
    fs.rmSync(path.join(pdir, "particles", "burst_c1.json"));
    assert.ok(/child system "particles\/burst_c1.json" not found/.test(validateProject(pdir)), "validate: a missing child file");
    fs.rmSync(pdir, { recursive: true, force: true });
  }
  // 26. add_puppet: the .mdl layout (decoded from 69 real puppets, a generated one loaded in WE), mesh cropped to the opaque part, bones in layer space, one script
  {
    const { addPuppet } = require(dist + "tools/puppet");
    const udir = fs.mkdtempSync(path.join(os.tmpdir(), "pup-"));
    for (const d of ["materials", "models"]) fs.mkdirSync(path.join(udir, d));
    const px = Buffer.alloc(64 * 32 * 4); for (let y = 0; y < 32; y++) for (let x = 16; x < 48; x++) px.set([200, 100, 50, 255], (y * 64 + x) * 4);   // opaque middle half only
    fs.writeFileSync(path.join(udir, "materials", "p.tex"), await encodeTex(px, 64, 32));
    fs.writeFileSync(path.join(udir, "materials", "p.json"), JSON.stringify({ passes: [{ shader: "genericimage4", combos: {}, textures: ["p"] }] }));
    fs.writeFileSync(path.join(udir, "models", "p.json"), JSON.stringify({ autosize: true, material: "materials/p.json" }));
    fs.writeFileSync(path.join(udir, "scene.json"), JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [{ id: 1, name: "p", image: "models/p.json", origin: "960 540 0", size: "64 32", scale: "1 1 1" }] }));
    fs.writeFileSync(path.join(udir, "project.json"), JSON.stringify({ type: "scene", file: "scene.json", general: { properties: {} } }));
    const two = [{ name: "a", x: 928, y: 540 }, { name: "b", x: 992, y: 540, parent: "a" }];
    await assert.rejects(addPuppet(udir, { layer: "p", bones: [{ name: "b", x: 0, y: 0, parent: "a" }, { name: "a", x: 0, y: 0 }] }), /BEFORE/);
    await assert.rejects(addPuppet(udir, { layer: "p", bones: [two[0], two[0]] }), /twice/);
    assert.ok(!fs.existsSync(path.join(udir, "models", "p_mcp.json")), "a rejected call writes nothing");
    const out = await addPuppet(udir, { layer: "p", bones: two, detail: 8, lean: 5 });
    const b = fs.readFileSync(path.join(udir, "models", "p_mcp_puppet.mdl")); let q = 0;
    const cstr = () => { const e = b.indexOf(0, q); const s = b.toString("latin1", q, e); q = e + 1; return s; };
    assert.strictEqual(cstr(), "MDLV0019"); q += 12; assert.strictEqual(cstr(), "materials/p.json"); q += 28;
    assert.strictEqual(b.readUInt32LE(q), 0x0180000f); const vb = b.readUInt32LE(q + 4); q += 8;
    const nv = vb / 80, v = i => { const o = q + i * 80; return { x: b.readFloatLE(o), y: b.readFloatLE(o + 4), w: [b.readFloatLE(o + 56), b.readFloatLE(o + 60)], bi: [b.readUInt32LE(o + 40), b.readUInt32LE(o + 44)], u: b.readFloatLE(o + 72), v: b.readFloatLE(o + 76) }; };
    assert.ok(Number.isInteger(nv) && nv > 0 && nv < 9 * 5, `a grid of 8 x 4 cells has 45 vertices, the transparent edge is cropped: ${nv}`);
    for (let i = 0; i < nv; i++) { const p = v(i); assert.ok(Math.abs(p.w[0] + p.w[1] - 1) < 1e-5, "weights sum to 1"); assert.ok(p.x >= -32 && p.x <= 32 && p.y >= -16 && p.y <= 16 && p.u >= 0 && p.u <= 1, "mesh inside the layer"); assert.ok(Math.abs(p.u - (p.x + 32) / 64) < 1e-5 && Math.abs(p.v - (16 - p.y) / 32) < 1e-5, "uv.v = 0 is the top, y is up"); }
    q += vb; const ib = b.readUInt32LE(q); q += 4 + ib;
    assert.ok(ib % 6 === 0 && ib > 0, "triangles");
    assert.strictEqual(cstr(), "MDLS0002"); const end = b.readUInt32LE(q); assert.strictEqual(end, b.length, "MDLS end offset = file size (nothing after the records)"); assert.strictEqual(b.readUInt32LE(q + 4), 2, "two bones"); q += 8;
    const bone = () => { const name = cstr(), flags = b.readUInt32LE(q), parent = b.readInt32LE(q + 4); q += 12; const m = Array.from({ length: 16 }, (_, k) => b.readFloatLE(q + k * 4)); q += 64; cstr(); return { name, flags, parent, tx: m[12], ty: m[13] }; };
    const b0 = bone(), b1 = bone();
    assert.deepStrictEqual([b0.name, b0.parent, b0.tx, b0.ty, b1.name, b1.parent, b1.tx, b1.ty], ["a", -1, -32, 0, "b", 0, 64, 0], "root relative to the layer centre, child relative to its parent");
    assert.strictEqual(b.length - q, 13 + 80 * 2, "record block = 13 + 80 x bones");
    const so = openScene(udir).scene.objects[0];
    assert.strictEqual(so.image, "models/p_mcp.json"); assert.strictEqual(JSON.parse(fs.readFileSync(path.join(udir, "models", "p_mcp.json"), "utf8")).puppet, "models/p_mcp_puppet.mdl");
    assert.ok(/setLocalBoneAngles/.test(so.alpha.script) && /"swayOn"/.test(so.alpha.script) && !/"leanOn"/.test(so.alpha.script), "one script on alpha: horizontal bones sway but cannot lean");
    assert.ok(/2 bone\(s\)/.test(out) && /Lean ignored/.test(out), out);
    const up = await addPuppet(udir, { layer: "p", bones: [{ name: "a", x: 960, y: 556 }, { name: "b", x: 960, y: 524, parent: "a" }], lean: 5 });
    const us = openScene(udir).scene.objects[0].alpha.script; assert.ok(/"leanOn"/.test(us) && !/Lean ignored/.test(up), "vertical bones lean");
    assert.ok(/BONES = \[\[0,0\.05236,-0\.08727,0\],\[1,0\.05236,-0\.08727,1\]\]/.test(us), "an upright bone leans toward the cursor = clockwise (negative): " + us.match(/BONES = .*?\]\]/)[0]);
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(udir, "project.json"), "utf8")).general.properties).filter(k => /^(p_|anim_)/.test(k)).sort(), ["anim_master", "anim_speed", "p_lean", "p_lean_amt", "p_sway", "p_sway_amt"], "switches and sliders");
    await addPuppet(udir, { layer: "p", bones: two, sway: 0, lean: 0 }); assert.strictEqual(openScene(udir).scene.objects[0].image, "models/p_mcp.json", "running it again redoes our own puppet");
    // bone physics (constraint JSON on every bone with a parent) and attachment points (MDAT) with a layer riding on one
    const sio = require(dist + "sceneio"), s2 = openScene(udir);
    s2.scene.objects.push({ id: 2, name: "rider", image: "models/p.json", origin: "1000 540 0", size: "10 10", scale: "1 1 1" }); sio.saveScene(s2);
    await assert.rejects(addPuppet(udir, { layer: "p", bones: two, attach: [{ name: "x", x: 0, y: 0, bone: "nope" }] }), /no bone called/);
    await assert.rejects(addPuppet(udir, { layer: "p", bones: two, attach: [{ name: "x", x: 0, y: 0, layers: ["p"] }] }), /puppet itself/);
    await assert.rejects(addPuppet(udir, { layer: "p", bones: two, attach: [{ name: "x", x: 0, y: 0 }, { name: "x", x: 1, y: 1 }] }), /twice/);
    const pout = await addPuppet(udir, { layer: "p", bones: two, sway: 4, physics: { gravity: true, limit: 30 }, attach: [{ name: "pt", x: 1000, y: 500, bone: "b", layers: ["rider"] }] });
    const pb = fs.readFileSync(path.join(udir, "models", "p_mcp_puppet.mdl")), mat = pb.indexOf("MDAT0001\0"), js = [...pb.toString("latin1").matchAll(/\{"a":.*?\}(?=\0)/g)].map(m => JSON.parse(m[0]));
    assert.strictEqual(js.length, 1, "only the bone with a parent is simulated"); assert.deepStrictEqual([js[0].ge, js[0].se, js[0].re, js[0].r, js[0].lamax, js[0].lamin, js[0].tp, js[0].a], [true, true, false, true, "0.00000 0.00000 0.52360", "0.00000 0.00000 -0.52360", "64.00000 0.00000 0.00000", "1.00000 0.00000 0.00000"], "spring, gravity, limit 30 deg, tip along the bone");
    assert.strictEqual(pb.readUInt32LE(pb.indexOf("MDLS0002\0") + 9), mat, "MDLS ends where MDAT starts");
    assert.strictEqual(pb.readUInt32LE(mat + 9), pb.length - 1, "MDAT is last: end = file size - 1"); assert.strictEqual(pb[pb.length - 1], 0); assert.strictEqual(pb.readUInt16LE(mat + 13), 1);
    assert.strictEqual(pb.readUInt16LE(mat + 15), 1, "on bone b"); assert.strictEqual(pb.toString("latin1", mat + 17, mat + 19), "pt");
    assert.deepStrictEqual([pb.readFloatLE(mat + 20 + 48), pb.readFloatLE(mat + 20 + 52)], [8, 40], "offset from the bone joint, layer px, y up");
    const rd = openScene(udir).scene.objects[1], ro = sio.parseVec(rd.origin, [0, 0, 0]);
    assert.deepStrictEqual([rd.parent, rd.attachment, Math.round(ro[0]), Math.round(ro[1])], [1, "pt", 0, -40], "the rider keeps its place: local to the attachment point");
    assert.ok(/BONES = \[\[0,0\.06981,0,0\]\]/.test(openScene(udir).scene.objects[0].alpha.script) && /Bone physics \(spring\) on: b/.test(pout) && /carries "rider"/.test(pout), "root sways, the physics bone does not");
    fs.writeFileSync(path.join(udir, "models", "p.json"), JSON.stringify({ material: "materials/p.json", puppet: "models/p_puppet.mdl" }));
    const sc = openScene(udir); sc.scene.objects[0].image = "models/p.json"; require(dist + "sceneio").saveScene(sc);
    await assert.rejects(addPuppet(udir, { layer: "p", bones: two }), /made in the editor/);
    fs.rmSync(udir, { recursive: true, force: true });
  }
  console.log("selfcheck ok");
})().catch(e => { console.error("selfcheck FAILED:", e.stack); process.exit(1); });
