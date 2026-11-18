# Scene wallpaper guide (read this before building)

Scene wallpapers are what the Wallpaper Engine editor produces: a canvas plus ordered layers with effects, animations,
particles, text and sound. Everything these tools write is the native format (`scene.json` + `.tex`), so the user can open the
project in the editor and fine-tune it by hand (layer panel, effect sliders, user properties). Prefer scenes over web
wallpapers unless you need custom code (canvas/WebGL/shaders).

## 1. Coordinates - the usual source of mistakes

- Every position you pass is in **canvas pixels, origin TOP-LEFT, x right, y DOWN**. `(0,0)` = top-left, `(W,H)` = bottom-right.
  `get_scene` reports the same units (centre, on-screen size, bounding box) so you can verify every number.
- `x`,`y` place the layer's **anchor** (default `center`). Other anchors: `top`, `bottom`, `left`, `right`, `top-left`,
  `top-right`, `bottom-left`, `bottom-right`. Standing character on a floor line: `x:1400, y:980, anchor:"bottom", height:900`.
- Size: `width` and/or `height` in canvas px (aspect kept if only one is given), or `scale`, or `fit` (`cover` / `contain` / `stretch`).
- `rotation` is in degrees, counter-clockwise positive. `scale` multiplies the natural texture size.
- z-order: `position` = `"top"` (default) | `"bottom"` | index | `{above: layer}` | `{below: layer}`. Last layer = drawn on top.
- Layers are referenced by numeric id or by name (`get_scene` lists both).
- `update_layer` with `dx`/`dy` moves relative to where the layer is now; scale and rotation act about the anchor you pass.
- Children (`parent`) inherit position, scale and rotation of the parent. A **group** is an invisible pivot: put layers under it and
  animate the group to move/rotate them together about the group's origin.

## 2. Workflow that gives good results

1. **Assets first.** Anything that must move separately needs its own transparent PNG (character, hair, cape, sword, glow, smoke).
   Backgrounds should be larger than the canvas when you plan sway/parallax. Check an image with `inspect_image` (shows size, visible
   bounding box and a labelled grid in source px) before placing it.
2. `create_scene_wallpaper` (name, image, `fit:"cover"`). Textures are converted to `.tex` automatically (no editor step needed).
3. `add_layer` back-to-front. After each important step call `preview_scene` (grid:true for coordinates, `region` to zoom into details).
4. Effects: `list_effects` -> `add_effect` with real parameter keys. Restrict them with masks (section 4).
5. Motion: `animate_layer` presets (`sway`, `float`, `breathe`, `glow`, `drift`, `flicker`, `spin`, `fade_in`).
6. `scene_settings` for bloom, parallax, clear colour. `add_particles` for rain/snow/embers/sparks/fog/light shafts.
   `add_effect_layer` (global post-process) and `add_solid_layer` (vignette, dimming, colour wash) last, above the layers they affect.
7. `validate_project` -> `preview_scene save_thumbnail:true` -> `apply_wallpaper` -> look at the real desktop (effects, particles and
   animation are NOT rendered by `preview_scene`; it shows layout only). To test without replacing the user's desktop wallpaper use
   `capture_wallpaper {project, frames:4, interval_ms:500}`: it opens a pop-out window, waits for the load and returns what Wallpaper Engine
   really renders (a filmstrip, so you can judge sway, waves, particles). `crop:{x,y,w,h}` (fractions of the window) zooms into the hair, the
   blade, ... To test the interactive parts add `cursor:{x,y}` (mouse-follow scripts), `click:true` (click effects, `interval_ms:0` gives ~80 ms
   between frames and the labels show the real seconds after the click) and `properties:{key:value}` (a switch or slider for this capture only).
   `validate_project` ends with a performance estimate (texture memory vs the 300/500 MB guideline, effect load); keep it green. Keep the window size constant between calls (reopening the same window name at another size can render into a smaller area).

## 3. Layout rules of thumb

- Canvas defaults to 1920x1080. Use 2560x1440 or 3840x2160 for sharper walls; textures bigger than 8192px are downscaled.
- Leave headroom: layers that sway, shake or scroll show their edges. Make the background layer 5-10% larger than the canvas
  (`width`/`height` > canvas) or keep the moving layer's edges off-screen.
- Keep the subject inside the middle 60% of the canvas (desktop icons, taskbar and multiple monitors crop the edges).
- Decide the focal point first (rule of thirds), then place secondary layers relative to it with `dx`/`dy`.
- Use `parallax_depth` (0 = fixed .. 1 = moves most) together with `scene_settings parallax.enabled` for depth: background 0.1-0.3,
  mid 0.4-0.6, foreground 0.8-1.0. Parallax needs separated layers - it is the cheapest way to get a "3D" feel.
  Once parallax is on, WE moves every layer that has NO `parallaxDepth` (and a group + its child would move twice), which tears copies of the
  same picture apart. The tools therefore write depth 0 on every layer without an explicit one (`scene_settings` for existing layers, every new layer afterwards).

### One figure inside a flat picture (no cut-outs): the overlay-copy recipe

You do not need separate PNGs to make only the character move. A python script builds the masks, a node script calls the tools:
- `sky`: the plain picture, static. Cloth hanging from the body: `waterwaves` on it with an opacity mask (pinned where it leaves the body) + a timeoffset gradient.
- `figure`: `duplicate_layer` of the picture (shares the texture), `opacity` effect with a generous, feathered mask around head/torso/arm, then
  `waterwaves` on the hair spikes (mask pinned at the skull). `animate_layer` `angles` (~1 deg) + `scale` (~0.01) with `pivot` at the waist: the copy
  breathes and sways while everything under it stays still. Keep the mask edges in plain background (sky) or near the pivot, so the seam never shows.
- Glow around the figure: `add_solid_layer` colour + `blend:"multiply"` + `opacity` effect with an "outside the silhouette" mask (extend it a few px
  inside the outline). Multiply keeps the line art; a normal blend paints over it and leaves white rings wherever the copy moves.
- Wind: a seamless streak texture, `add_layer tile:true` + `scroll` (speedx/speedy along the streak angle) + an opacity mask (light lines over dark areas,
  dark lines over the sky). Rocks/debris cut out of the picture are separate layers with `animate_layer` origin + angles.
- `waterwaves` on a full-canvas layer: pixels move **strength² x layer size** px along (cos direction, sin direction), image space y down. The hand-made 0.12-0.24 values moved a first test wallpaper 35-150 px, with speed 5-6: hair dragged over the left eye, cloth torn, a pale "ghost" where the static aura mask did not cover the uncovered sky. What worked: hair 0.052 (~7 px), tail 0.07 (~11 px), left cloth 0.085 (~12 px), speed ~2, direction perpendicular to the cloth axis, a face-protection hole in the hair mask, and aura footprints around hair/cloth edges. add_effect prints the peak px: keep it at 3-12.
- Check every step with `capture_wallpaper` (frames + crop). Particles with large `size`/`count` multipliers can wash the whole image: raise them gradually.

### Text layers (`add_text`)

- `size` is the font size in **canvas px** (the em; capital letters are ~0.72 of it). Typical on 1080p: headline 90-160, clock 120-220,
  subtitle 36-56, small caption 28-36. (Wallpaper Engine's own "point size" is px/4.17; the tool converts for you.)
- `(x, y)` is the **anchor** of the text, not a box centre: the centre for `align:"center"`, the left edge for `"left"`, the right edge
  for `"right"`; the line block is vertically centred on `y`. Wallpaper Engine sizes the text box around the text, so no width/height.
- `max_width` wraps long text at that width (px); `\n` makes line breaks. `rotation` is counter-clockwise degrees about the anchor.
- `preview_scene` draws text in Arial; other fonts are 5-15% wider/narrower, so leave some margin next to the canvas edge.

### Solid and post-process layers (`add_solid_layer`, `add_effect_layer`)

These are the editor's texture-less utility layers (verified in WE). Effects always apply to the layer they sit on, so a layer that
should affect "everything" needs one of these:

- `add_effect_layer` (`kind:"fullscreen"`) = post-process: every effect added to it (`add_effect`) is applied to ALL layers below it in
  the z-order. Use it for `godrays`, `shine`, `tint` (global grade), `chromaticaberration`, `filmgrain`, `vhs`, `localcontrast`, `blur`, `fisheye`,
  Workshop effects like `cutout_vignette`. Keep text/UI above it. Mask shapes use canvas px. `kind:"area"` does the same inside a rectangle only.
  Scene-wide bloom is `scene_settings`, not a layer.
- `add_solid_layer` = flat colour rectangle (whole canvas, black by default). Combine with `alpha`, `blend` (multiply = darken, screen/add = glow,
  overlay/soft-light = grade) or with the `opacity` effect, whose result is simply `alpha x mask`:
  - vignette: solid black + `opacity {alpha:0.85}` + mask `{shapes:[{type:"radial", cx:W/2, cy:H/2, r:~0.6*W, inner:0.4}], invert:true}`
  - bottom fade for text: mask `{shapes:[{type:"gradient", from:[0,H*0.65], to:[0,H], from_value:0, to_value:1}]}`
  - soft shadow behind a panel: small solid + `opacity` + `blur`.
- `preview_scene` draws solid layers and the `opacity` effect; post-process layers are only listed (apply the wallpaper to see them).
- `validate_project` warns about a post-process layer that has no effects.

## 4. Masks: how to make an effect affect only part of a layer

A mask is a greyscale picture mapped over the layer: white = effect fully on, black = off. `create_mask` and the `masks` argument of
`add_effect` / `update_effect` build one from:

- `shapes` (default coordinates = **canvas px**, i.e. what you read off `preview_scene`; `space:"layer"` = texture px of the layer):
  `rect`, `ellipse`, `polygon` (points), `path` (SVG path), `gradient` (from/to), `radial` (soft spot). Add `feather` (px) for soft edges.
  Later shapes paint over earlier ones; `value:0` subtracts. `base:1` starts fully on.
- `from_layer:true` = the layer's own silhouette (alpha).
- `color:{color, tolerance, softness}` = where the layer's picture is close to a colour (a colour key: "the red hair"); `threshold` (0..1) turns any
  soft source into a hard on/off first.
- `image` = a painted PNG (white = on) or an existing `masks/...` name.
- Refine the result (all in mask px): `grow` (negative = shrink), `falloff` (fades out beyond the edge, e.g. an aura that thins with distance),
  `combine:[{op:"add"|"subtract"|"intersect", ...another source}]` (e.g. the body silhouette minus the face), then `blur`, `invert`.

Always verify: `preview_scene {masks_of:[layer]}` tints the masks red on top of the layer. A mask with 0% coverage is reported as a
warning because the effect would be invisible.

Effects that have several slots: `masks.opacity` (where it applies), `masks.flow` (direction map, e.g. shake), `masks.timeoffset`
(phase offset so different parts move out of sync).

## 5. Motion that looks natural

- Never use one loop for everything: vary `period` (e.g. 4.3 s, 5.7 s, 7.1 s) and `phase` between layers (hair vs cape vs body).
- Typical amplitudes: idle sway 1-3 degrees (period 4-7 s), breathing scale 0.5-1.5% (3-5 s), float 6-16 px (4-6 s), drift 20-60 px (10-20 s),
  glow alpha +-0.15..0.3 (2-4 s), flicker brightness +-0.1..0.3.
- `sway` and `breathe` rotate/scale about the **base** of the layer by creating a pivot group (use `pivot:"center"` for the layer's own
  centre, or `{x,y}` canvas px for a custom pivot such as the waist).
- Effects can animate too: `animate_layer {effect:"shake", param:"strength", wave:"pulse", period:3, amplitude:0.1}`.
- Animations are keyframe offsets around the static pose, so position the layer first, animate afterwards.

## 6. Recipes

- **Anime character idle**: background plate (fit cover) -> character PNG (anchor bottom) -> `animate_layer sway` (1.5 deg, period 5.5)
  + `breathe` -> hair/cape as separate PNGs with a different `sway` phase, or one `shake`/`foliagesway` effect with a polygon mask over the hair
  -> `waterwaves` (strength 0.05, scale 10, speed 3) with a low mask on the background for heat haze -> `add_particles ember` -> bloom.
- **Hair / cloth the way hand-made wallpapers do it** (studied in a professional example scene with 80+ hair layers): cut the art into
  separate PNGs (back hair, front strands, fringe, ribbons), parent them to the body, and give EACH its own `waterwaves` with slightly different
  numbers (these values suit SMALL strand layers: the reach is strength² x layer size, see below): `strength 0.16-0.3, scale 3-6, speed 5-8.5, exponent 1, direction ~-2.4..-3.1` plus two masks - `opacity` (black at the roots,
  white on the free part) and `timeoffset` (gradient root 0 -> tip 1, so the wave travels down the strand). Copies of one strand (mirrored with a
  negative `scale`, rotated, resized) get different speed/direction so they never move in lockstep.
  Example: `add_effect {layer:"hair front", effect:"waterwaves", values:{strength:0.22, scale:4, speed:6.3, direction:"-140deg"}, masks:{opacity:{shapes:[{type:"gradient", from:[820,300], to:[820,640]}]}, timeoffset:{shapes:[{type:"gradient", from:[820,300], to:[820,640]}]}}}`.
  Breathing / head turns are slow `animate_layer` loops on the body group; toggles for them are user properties (`visible:{property:"headmovement"...}`).
- **Rainy window**: background -> `add_particles rain/rainrefractive` -> `waterripple`/`reflection` on the glass layer -> slow `float` on foreground
  plants -> `scene_settings bloom` low strength.
- **Space / sci-fi**: background -> `add_particles stars/starfield` + `shootingstar` -> `shine`/`pulse` on lights with masks -> `scroll` on nebula layers.
- **Fire / energy**: sprite layer -> `fire` or `nitro` effect with a mask -> `pulse` (PULSEALPHA) -> additive blend (`blend:"add"`) glow layers
  duplicated with `duplicate_layer` and `scale_by`.
- **Clock wallpaper**: `add_text dynamic:"clock"` (+ `date`/`day`) with `user properties` for colour (pass `color:{property:"clockcolor"}`).

## 7. Editable-by-the-user switches

Pass `{ "property": "name", "label": "Shown label", "type": "bool|slider|color|combo|textinput", "value": ... }` instead of a plain value for
`visible`, `alpha`, `color`, `brightness`, effect `values`, `volume`, `clear_color`. The tool creates the property in project.json and
binds it, so the user gets a checkbox/slider in the Wallpaper Engine properties panel (and `control_wallpaper apply_properties` can change it live).
For layout/style selectors make one `combo` property and bind `visible` of each variant with `condition`:
`visible:{property:"style", type:"combo", options:[{label:"Day",value:"1"},{label:"Night",value:"2"}], value:"1", condition:"2"}` = visible only while "Night" is chosen.

### Scripts and options (`add_script`): continuous motion the viewer can switch off

Keyframes loop visibly; SceneScripts run every frame, so motion never repeats and can react to the mouse. `add_script {list:true}` prints the
templates: `wobble` (3-sine organic noise / sine / breath on origin, angles, scale), `cursor` (spring-smoothed lean toward the mouse),
`lag` (spring follow-through that reads another script's output: the head trailing the body), `gain` (scales a number: effect strength,
alpha, scroll speed - with noise / sine / heartbeat / burst modulation, `hold` to keep a resting value when off, `root` to keep a
waterwaves slider linear in pixels), `scene` (camera parallax / bloom / shake), `click` (press effects), and the newer `audio`, `event`, `media`, `emit` (see below) and `daytime`, `hover`, `toggle`, `launch` (see "Time of day, hover, toggles, launchers").
Every template has an `enabled` switch, an `amount` slider, the global `master` and `speed`; bind them to user properties:
`bind:{enabled:{property:"hair_on",label:"Hair"}, amount:{property:"hair_amt",label:"Hair amount",min:0,max:2,show_if:"hair_on"}, master:{property:"anim_master"}}`.
Several scripts may bind the same property (one master switch, one speed slider). One property takes ONE script: nest groups for several motions
(lean > sway > breath > head > head look > head aim).
`update_properties`/`scene_settings` accept `type:"group"` (a heading) and `show_if:"<switch>"` (hide a slider while its switch is off).
Verified in WE 2.8: scripts run in the pop-out window, toggles and sliders take effect live, `input.cursorWorldPosition` is canvas px with y up,
scripts see angles in DEGREES. Tips learnt on the way: when a figure moves relative to an overlay (aura hole, shadow), parent the overlay to
the same group; keep waterwaves reach (strength² x layer size) below ~10 px on faces; masks for a moving head must be opaque across the old AND
new position with the feather in plain sky.
More tips (a character scene with mouse lean, aura and click sparks):
- A lean that looks "chained at the feet" pivots about the wrong point: put the lean group at the BOTTOM of the figure and let the whole figure
  (body, cloak, blade, aura) rotate with it; the sway/breath groups ride inside it.
- An aura is a multiply `solid` layer with an `opacity` mask (stays on the line art) parented to what moves; the head needs its own aura layer on the
  head group, otherwise the white sky shows between aura and hair. Same `seed` on both layers keeps their pulses in sync.
- Mouse clicks: `add_script {template:"click", property:"visible", targets:["spark 0","spark 1",...], duration:0.45}` on a full-canvas solid with alpha 0
  at the top of the stack. Create the targets with `add_particles ... visible:false`; each press moves the next one to the cursor and shows it.
  Bursts do not restart when a layer becomes visible again, so use a continuous spray (`add_particles {preset:"spark/spark", file:"sparktrails",
  patch:{emitter:[{instantaneous:0, rate:300, speedmax:1100}], ...}}`); additive materials vanish on white skies, use size 8+ and saturated colours.

A whole figure in one call: `add_motion_rig {project, body:[layers...], head:[layers...], head_pivot:{x,y}}` builds the groups described above
(lean > sway > breath for the body, head > head look > head aim inside it), re-parents the layers without moving them, adds the scripts and the
user options (one switch + amount slider per movement, plus a master switch and a speed slider). Pick the motions with `motions`; judge the
result with `capture_wallpaper {cursor:{x,y}}`.

Before a big restructuring `backup_project {project}`; `restore_project {project}` lists the copies (and `delete_wallpaper` keeps one by itself).

### Puppet warp (`add_puppet`)

For a part that must bend instead of turning rigidly (tail, hair lock, ear, tentacle, arm, cape): `add_puppet {project, layer, bones:[{name, x, y, parent?}...]}`.
You place the joints, the tool does the rest (mesh, skin weights, the `.mdl`, the script).

- `bones` are canvas px, origin top-left, y down, like every other position. A bone is a joint: it rotates about its (x,y) and carries its children.
  List parents before children; no `parent` = a root. Chain from the fixed end to the free end: base of the tail first, tip last. The last bone of a chain points
  away from its parent, so put it where the tip really is. Put joints where the part should bend, and keep a rigid area (a hip, the head root) near ONE bone.
- The mesh is a grid over the picture's opaque pixels (`detail` cells along the longer side, default 40, 8..200); every vertex follows its two nearest bones.
  More `detail` = smoother edges, more vertices. Soft, long parts work best; sharp-edged hard parts (armour) look soft at a bone joint.
- Motion is one script on the layer's `alpha` (SceneScript `thisLayer.setLocalBoneAngles`). `sway` = idle swing in degrees per bone (default 3, children trail
  their parent by `lag` seconds, one cycle every `period` seconds), `lean` = bend toward the mouse (degrees at the screen edge; the sign is automatic from the bone
  direction, so a horizontal bone cannot lean and a note says so). Each motion has its own switch + amount slider (`<name>_sway`, `<name>_lean`, `*_amt`) plus
  the shared "Animate everything" / "Animation speed". `sway:0` on a bone keeps it rigid (use it for the root).
- The mesh follows the picture's ALPHA, so the layer needs a real cut-out. A flat illustration that was animated with `opacity` masks (the layer is the whole picture
  and an effect hides the rest) must be cut first: multiply the picture by the mask, sharpen the mask at its 50 % line (feathered masks leave a halo that then bends
  with the mesh), crop to the opaque box, `add_layer` the PNG at the box centre with the same parent, `add_puppet` it, then remove the old layer and its effects.
  Keep one bone chain per part that must move and a rigid chain (`sway:0, physics:false`) along parts that must not (a sword, a face); the weights are by
  distance, so an area without a bone nearby is dragged by whichever bone is closest. Measured on a 2560x1440 manga scene: 24 + 10 bones, 12k + 11k vertices,
  the effect load fell from ~20.6 to ~11.6 full-canvas passes and texture memory from 80 to 59 MB.
- Running it again on the same layer replaces the puppet (new bones, new mesh). A puppet made in the editor is refused: add bones there.
- Judge with `capture_wallpaper {frames:4}`; for `lean` use `cursor:{x,y}` with `click:true` (the window must be in front or the engine ignores the mouse) and
  a NEW window name for every check (bones keep their last pose inside an open window when a script changes).
- Bone physics: `physics:true` (or `{mode, stiffness, friction, inertia, mass, gravity, limit}`) switches on Wallpaper Engine's own bone simulation on every bone
  that has a parent, so hair, a tail or a rope trails the movement of its parent with inertia. Keep `sway` on the ROOT bone (it drives the others); a physics bone
  has no sway of its own unless you give it one, and `physics:false` on a bone keeps it out. `mode:"spring"` (default) pulls back to the rest pose (`stiffness`,
  `friction` = calm, `inertia` = reacts less to fast moves, `limit` = max degrees each way); `mode:"rigid"` keeps the last pose and only drags. `gravity:true` with
  `rigid` makes a chain hang down. The last bone of a chain is turned to point along its parent (the editor's "tip forward angle"). Physics has no switch in the
  properties panel and its look changes with the FPS limit of the viewer (Wallpaper Engine's own note). Measured: physics bones react to a SCRIPT-driven parent
  (root sway) and need no animation clip.
- Attachment points: `attach:[{name, x, y, bone?, layers:[...]}]` writes points on the skeleton (default bone: the nearest) and parents the listed layers to them. Each
  layer keeps its place and then follows that bone: an earring, a hair clip, a held object, or a body part of a character made of separate PNGs (put each part on its
  own layer, give the body puppet one point per part). Run `add_puppet` again with the riders listed again to change them.
- Not covered: keyframe clips stored in the model (MDLA; the scripts do the motion instead), IK, blend shapes, one mesh built from several part PNGs (the editor's
  character sheet): use attachment points on a body puppet for that. `find_examples {feature:"puppet"}` / `copy_example_layer` copy a working editor-made puppet
  (with its animations) into your scene. Not checked: opening our puppet in the editor.

### Lights (`add_light`)

`add_light {type:"point"|"spot"|"tube"|"directional", x, y, height, color, intensity, radius}` adds a real light that shades the image layers (a lamp, a fire
glow, a spotlight on the hero, a neon tube, moonlight). `x,y` are canvas px like everywhere else, `height` is how far the light floats above the wallpaper,
`radius` is its reach in px, `intensity` 1 = subtle, 5-10 = strong, 100 = blown out. A spot and a directional light shine at `aim:{x,y}` (default: straight
down); a spot has `cone:{inner,outer}` in degrees; a tube runs to `to:{x,y}`. Facts measured in WE 2.8: an image layer only receives light when its material has
the `LIGHTING` combo (the tool switches it on for `lit:"all"` layers, or `update_layer {lighting:true}`); lit layers are multiplied by the scene ambient light
(0.3 by default, so the picture gets darker: raise it with `ambient:0.6` or `scene_settings`); sprite sheets and effect layers are not lightable;
`general.lightconfig` (the count per light type) is kept right by every save. `intensity`, `color`, `radius` and `visible` accept `{property:...}` user options, and
`add_script {property:"intensity", template:"gain" | "audio"}` makes a flickering torch or a light that follows the bass. `preview_scene` does not draw lights: use `capture_wallpaper`.

### Music: reaction (`audio`) and now playing (`media`)

`add_script {template:"audio", property:"alpha"|"brightness"|"intensity"|"radius"|"scale"|"origin"|"angles"|<effect+param>, band:"bass"|"mid"|"treble"|"all"|[firstBin,lastBin]}`
reads the 16 spectrum bins of `engine.registerAudioBuffers`. Measured with pure tones: 60 Hz = bin 0, 400 Hz = bin 4-5, 2 kHz = bin 9, about half an octave per bin up to
~18 kHz (bass = bins 0-3, mid = 4-10, treble = 11-15). The loudest bin of the band counts; `attack` and `smooth` shape the rise and the decay. On numbers the value pulses between
base x `min` (silence) and base x `max`; on origin / angles / scale `amplitude` is added at full level. The viewer gets `enabled`, `amount` (reaction) and `sensitivity`
sliders (bind them like any script property). `project.json general.supportsaudioprocessing` is switched on automatically whenever a scene uses an audio script
or an `AUDIOPROCESSING` effect combo (without it the scripts get silence); `validate_project` flags a hand-edited project that lacks it.
`add_script {template:"media", property:"text"}` on an `add_text` layer shows the playing track (`format:"{artist} - {title}"`, `fallback`), and on a `color` property it eases to the
album-art colour (`which: primary | secondary | tertiary | text`). Both need the user's Windows media integration to be on.

### Animated images and video (`add_layer`)

- `add_layer {frames:[a.png, b.png, ...], sprite:{fps:12}}` (same-size images) or `add_layer {image:"sheet.png", sprite:{cols, rows, count?, fps}}` makes ONE layer with an animated
  texture (a flame, a walk cycle, a logo); the layer is as big as one frame. Wallpaper Engine rebuilds the `.tex` from the png + `.tex-json` on load, so the tool writes both.
  GIF files are not read: split them into PNGs first. A sprite layer is not lit by `add_light`.
- `add_layer {video:"C:/clips/loop.mp4"}` makes a video layer (the mp4 is copied into `materials/`, the `.tex` wrapper is byte-identical to the editor's). Effects and masks work on it.
  mp4 only; the codec has to play on the viewer's Windows; a rotated (phone) video is not corrected. Control playback with a custom script on `thisLayer.getVideoTexture()` (`play`, `pause`, `loop`).

### Animation events (`animate_layer events` + `add_script template:"event"`)

`animate_layer {layer, property:"origin", amplitude:[0,0], period:6, events:[{t:1, name:"flash"}, {t:4, name:"spark"}]}` writes named moments into the cycle (an amplitude of 0 makes a pure timer);
`add_script {layer, property:"visible", template:"event", on:"flash", targets:["flash layer"], duration:0.4, emit:["sparks"], sounds:["boom"]}` on the SAME layer shows layers, bursts
particle systems (`emitParticles`) and plays sound layers at those moments. Verified in WE 2.8 (the event reaches `export function animationEvent(event)`; when a pivot group carries
the animation, put the script on the group). `template:"emit"` does periodic particle bursts on its own (bursts that restart after a layer became visible again are exactly what it fixes).

### Learning from the installed wallpapers (`find_examples`, `copy_example_layer`)

`find_examples {effect:"waterwaves"}` / `{feature:"audio"|"media"|"cursor"|"lights"|"puppet"|"video"...}` / `{query:"title or Workshop id"}` searches your Workshop, default and own scenes
(layers, effects used, features). `copy_example_layer {source:<id>}` prints the layer tree, the scene settings and the user properties; with `layer` it adds the effect parameter values and
script sources of that layer and its children; with `project` it COPIES the layer (children, effects, masks, scripts, models, materials, textures, particles, shaders, sounds - a local
Workshop effect comes with its shaders) into your project. Limits: user-property bindings become fixed values, scene-level settings (bloom, parallax, ambient) are not copied, and it refuses
when your project already has different files at the same paths. `list_monitors` shows which wallpaper each monitor runs (read-only).

### Relief, reflections and light beams (`set_material`, `add_light volumetrics`)

Lights only shade a flat picture; a normal map gives it relief to rake across. `set_material {layer, normal_map:"auto"}` derives the relief from the picture itself (bright = raised;
`normal_strength` default 3, 1 gentle, 6 deep; `normal_blur` smooths it; `flip_y` if the light seems to come from the wrong side). Or pass your own normal map image.
`metallic_map`, `roughness_map`, `reflection_map`, `emissive_map` take grayscale images (written as single-channel textures), or use the constants `metallic`, `roughness`,
`specular_tint`, `emissive {color, brightness}`. `reflection:true` mirrors what is drawn BELOW the layer, bent by the normal map (water, glass, a polished floor); it is subtle on gentle
relief, so use `normal_strength` 40-100 on a soft picture and `metallic` near 1. Verified live: a bright disc above a rippled glass mirrors in it. `clear:true` removes it all.
`add_light {volumetrics:true | {density, exponent}}` draws the beam in the air (best on a spot; density 0.5-1 for a thin beam, 3+ washes the picture out).
Official tips: with lights and reflections use a BLACK background (the clear colour), at most 4 lights per scene (a bright `ambient` is cheaper than another light), and
`validate_project` warns about more than 4. Not offered: texture projection on a spot and cast shadows (not verified in the editor files, so not guessed).

### Time of day, hover, toggles, launchers (`add_script` templates)

- `daytime {property:"alpha"|"brightness"|"intensity"|"radius"|"count"|"rate"|<effect param>, hours:[18,6], fade:1}`: the value follows the viewer's local hour (a night overlay, lit windows,
  a lamp that comes on); `hours` may wrap midnight; a bound `hour` slider (-1 = real clock) lets the viewer preview a time of day. Complementary `hours` on several layers make dawn / day / dusk / night.
  For a background that changes with the day prefer ONE layer with the Blend effect to a stack of full-size layers (video memory).
- `hover`: a number (alpha, brightness, particle rate) eases between `rest` and `hover` while the cursor is over the layer (`cursorEnter` / `cursorLeave`);
  `toggle {targets:[...]}`: a click on the layer shows / hides the targets and the choice is kept across restarts (`localStorage`, 100 KB per wallpaper);
  `launch`: a click opens the application the viewer picked in a `usershortcut` user property (`shortcut`, `label`).
- Particle systems: `add_script {property:"count"|"rate"|"size"|"speed"|"lifetime"|"alpha"}` (or a `{property}` binding on the same fields of `add_particles`) drives the emitter multipliers
  (`instanceoverride`) - a "rain amount" slider, or more fireflies at night.
- Texture property: `update_properties` with `type:"texture"` creates a slot where the viewer picks an image or video; bind it with `add_layer/update_layer {texture_property:"name"}`.
  Start from a small placeholder (e.g. 244x144 px scaled 7.5x for a 1920x1080 canvas) so the default costs nothing; a replacement is shown at the layer's size.
- RGB hardware (Corsair iCUE, Razer Chroma): `led:true` on ONE small layer (a 32x32 solid is enough, inside the visible area) makes only that layer drive the LEDs. Only the file is checked here (`validate_project` warns about several sources or a big one).
- Bloom: `scene_settings {hdr:true, bloom:{hdr:{strength, scatter, threshold, smoothing}}}`; only viewers with post-processing "Ultra" see the HDR bloom, so set the plain bloom too.
- `animate_layer {linear:true}` = constant speed between keyframes (a cloud crossing the sky), `wrap_loop`, `name` (for `thisLayer.getAnimation(name)`), `start_paused`.

### Your own effects and particle systems (`create_effect`, `create_particles`)

`create_effect {project, name, params:[{key, type?:"float"|"vec2"|"vec3"|"color", default, range, label}], code}` writes `effects/<name>/effect.json`, the material and the `.frag/.vert` pair,
exactly what Add Effect > New makes in the editor. You write only the body of the fragment shader: it runs on `albedo` (the layer pixel, assign to change it), with `uv`, `original`,
`mask` (the opacity mask is built in), `g_Time`, `g_Texture0` and one `u_<key>` per param. WE GLSL differs from plain GLSL: `texSample2D()`, `CAST3()`, `frac()`, `mul()`, `atan2()`, `saturate()`;
`hsv2rgb`, `rgb2hsv`, `rotateVec2`, `greyscale`, `M_PI` come from common.h. Then `add_effect {effect:"<name>", values:{amount:0.5}, masks...}` like any built-in; `list_effects {project}` lists
yours. Shader compile errors only show in the editor / `capture_wallpaper` (a black or unchanged layer = look at the code first). Verified live: a desaturation with a slider and a wobble using time + colour + vec2.

`create_particles {project, name, x, y, texture, emitter:[...], initializer:[...], operator:[...], renderer, control_points, children}` builds a system with WE's own component names:
- emitters `sphererandom` | `boxrandom` {rate, instantaneous (a burst; rate 0 + instantaneous = one shot), origin, directions, distancemin/max, speedmin/max}, `layerimage`;
- initializers (random between min and max): `lifetimerandom`, `sizerandom`, `colorrandom`, `alpharandom`, `velocityrandom`, `rotationrandom`, `angularvelocityrandom`, `turbulentvelocityrandom`,
  `positionoffsetrandom`, `hsvcolorrandom`, `colorlist`, `remapinitialvalue`, `inheritcontrolpointvelocity`, ...;
- operators: `movement` (REQUIRED for any motion), `alphafade`, `alphachange`, `colorchange`, `sizechange`, `angularmovement`, `turbulence`, `vortex`, `vortex_v2`, `controlpointattract`
  (negative scale pushes away; `threshold` = reach), `capvelocity`, `collision*`, `oscillate*`, `boids`, `remapvalue`...;
- renderers `sprite`, `spritetrail`, `rope`, `ropetrail`;
- `control_points` (ids 1-7, as an object keyed by id): id 0 is the system origin; `{pointer:true}` locks a point to the mouse, `{offset:[x,y]}` places it (`worldspace:true` = canvas
  px), `{parent:n}` copies the parent system's point n (for child systems);
- `children`: `{type:"static"|"eventfollow"|"eventspawn"|"eventdeath", system:{...} | file, maxcount, probability}` (a firework: a child that bursts where the parent dies; the child inherits
  the parent's texture and blending unless it sets its own).
`validate_project` checks the component names and the control point ids. Verified live: custom emitter / operators, a fixed control point attracting, an `eventdeath` child and a `spritetrail`
renderer. NOT verified live: a control point locked to the pointer (the capture window was covered).

### Video wallpapers, and shrinking the memory

`create_video_wallpaper {name, video:"C:/clips/loop.mp4"}` is the same as dropping an mp4 on the editor's Create Wallpaper: only `project.json` + the file. Want effects, particles or lights on the
video? Use `create_scene_wallpaper` and `add_layer {video}` instead. (Not run live: no video file was at hand.)
`optimize_textures {project}` re-encodes plain RGBA pictures as DXT5 (DXT1 when fully opaque): a quarter of the video memory for slight banding on smooth gradients. Sizes are padded to a
multiple of 16 (the editor pads to powers of two, so a 1920x1080 picture costs less here). Skips sprites, videos, compressed textures and stock assets; `backup_project` first. DXT1/DXT5 were
verified live at 1920x1088, 304x304, 304x128. More performance tips: a background that is larger than the canvas when parallax is on (no grey edge), few big effects with masks (the
estimate in `validate_project` counts full-canvas passes), at most 4 lights, no more particles than needed.

### From an illustration to layers with ComfyUI (recipe, not run here)

ComfyUI was not running while this was written, so this is the plan, not a tested pipeline - try it on ONE image first:
1. `import_image` (or the file itself) -> ComfyUI: bring it to 16:9 (outpaint), remember the final size.
2. Split into layers with a segmentation node (SAM / a background-removal node): background, body, hair, cloak, weapon... one transparent PNG each, same canvas size.
3. Fill what is behind each cut-out (inpaint the background plate and the body behind the hair) so moving a layer shows no hole.
4. Optional: a depth map (Depth Anything) -> `add_effect depthparallax` or a few `parallax_depth` values; grey masks from the segmentation -> `create_mask {image:...}` (A4).
5. `create_scene_wallpaper` -> one `add_layer` per PNG with `x:960,y:540` (all layers share the canvas, so no placement maths) -> effects with masks -> `add_motion_rig` /
   `add_script` -> `capture_wallpaper`.

## 8. Known limits

- Puppet warp is limited to `add_puppet` (skeleton, mesh, script-driven bones, bone physics, attachment points): no keyframe clips (MDLA), IK or single-mesh character sheets.
  For those use pivot sway, `swing`, `foliagesway`, `shake`, `waterwaves` with masks. Scenes that already contain editor-made puppets are read and kept intact.
- `preview_scene` does not simulate effects, particles, animations or scripts. Apply the wallpaper to judge motion.
- Not possible from outside the editor: creating playlists / profiles (Wallpaper Engine owns config.json while it runs; open existing ones with `control_wallpaper`), publishing to the Workshop, importing GIFs (split them into PNGs), `model` (3D) layers.

## 9. Troubleshooting

- Layer invisible: check `alpha`, `visible`, z-order (`get_scene`), and that the position is inside the canvas (bbox in `get_scene`).
- Effect does nothing: `strength` too small, mask empty/inverted (`preview_scene masks_of`), wrong effect slot, or effect hidden.
- Edges of a distorted layer look cut or wrap around: the layer is not larger than the area the effect pushes pixels over; enlarge it,
  lower the strength, or clamp the texture lookups with `update_layer {raw:{clampuvs:true}}`.
- Text is black / invisible: its colour was not white or a dark colour sits on a dark background (default colour is white).
- `apply_wallpaper` fails: Wallpaper Engine must be running (the tool starts it if it is not); re-apply to reload files from disk.
- Anything odd: `validate_project` lists missing files, duplicate ids, unknown user properties and effect pass mismatches.
