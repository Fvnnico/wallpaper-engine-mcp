# Effects cookbook

Values come from real Workshop scenes (median and typical range of ~150 wallpapers) and from the shader annotations installed with
Wallpaper Engine. Keys are the real parameter keys: `list_effects {effect:"<name>"}` prints every key, range, mask slot and combo.
Angles are radians (or pass `"45deg"`). Colours are `"r g b"` in 0-1 (or `#rrggbb`).

| Effect | What it does | Starting values | Notes |
|---|---|---|---|
| `shake` | jitters pixels (hair, cloth, leaves, electricity) | strength 0.1 (0.05-0.15), speed 1 (0.75-1.65), friction "1 1", bounds "0 1" | always mask it; `masks.flow` = direction map; `combos:{DIRECTION:"left"}` pins one side |
| `waterwaves` | wavy distortion: hair/cloth/grass sway, heat haze, water | hair/cloth: aim for 3-10 px of reach (see Notes), speed 1.5-3 (5-8 flutters), exponent 1, one effect per strand. Haze/water: strength 0.02-0.1, scale 10-200, speed 2-5 | pixels move by **strength² x layer size** px along (cos direction, sin direction), image space y down (measured): 2560 px layer, strength 0.05 = 6 px, 0.12 = 37 px, 0.24 = 147 px. Hand-made 0.15-0.3 values belong to small strand layers. `scale` = phase per layer width (3 = uniform over a head, 10-30 = a wave along a cloth). `masks.opacity` pins the roots and keeps faces out, `masks.timeoffset` (gradient root 0 -> tip 1) makes the phase flow along the strand. add_effect prints the peak px |
| `swing` | pendulum rotation about the axis point0-point1 | amount 0.07 (0.05-0.2), speed 1.5, size 0.4, center 0.5 | points are layer UV 0..1, y up |
| `foliagesway` | wind sway for plants/hair/cloth | strength 0.4, speeduv 5, scale 0.05, phase 0.5, power 1 | mask to pin the roots (black at the bottom) |
| `pulse` | pulses alpha or colour | speed 2 (1-3), amount 0.8, power 1, phase 0 | combos `PULSEALPHA`, `PULSECOLOR`, `BLENDMODE`; `AUDIOPROCESSING:1` = music reactive |
| `scroll` | scrolls the texture | speedx / speedy -0.5..0.5 | fog, clouds, rain streaks, speed lines, star layers; the layer needs `add_layer tile:true` and a seamless image or it just slides away |
| `cloudmotion` | slow organic cloud motion | amount 0.046, speed 0.025, direction 0.33 | very subtle by design |
| `godrays` | radial light rays | rayintensity 0.6 (0.3-1.3), raylength 0.5, raythreshold 0.4, center "0.5 0.5" | place center on the light source (0..1) |
| `lightshafts` | beams/shafts | see presets `lightshafts/*` | used on a quad layer: `add_particles preset:"lightshafts/..."` |
| `tint` | colour tint | color, alpha 1 | with a mask = local colour grading |
| `opacity` | layer alpha | alpha 1 | result = alpha x mask (the mask IS the visibility): vignettes, fades and soft shadows on `add_solid_layer` |
| `blur` | blur | scale "2 2" | `blurprecise`, `blurradial`, `motionblur` variants |
| `twirl` | swirl | amount 0.11, size 0.3, speed 1, center | |
| `spin` | rotates a circular region | speed -0.16, size 0.53, center "0.5 0.5" | |
| `iris` | eye/iris ring | noiseamount 0.5, rough 0.2, speed 1 | needs a mask on the eye |
| `depthparallax` | 2.5D parallax from a depth map | sens 1, center 0.3 | needs `scene_settings parallax.enabled` |
| `waterflow` | flowing water along a flow map | speed 0.21, strength 1, phasescale 2 | `masks.flow` = direction map |
| `fire` | procedural fire | speed 0.2, scale 10, distortion 3.5, colors | |
| `shimmer` | travelling glints | speed 0.5, brightness 0.87, granularity 1 | |

Masks quick reference (`masks:{opacity:{shapes:[...]}}`):

```json
{ "shapes": [
  { "type": "polygon", "points": [[820,300],[1010,310],[1000,640],[830,620]], "feather": 24 },
  { "type": "ellipse", "cx": 1100, "cy": 500, "rx": 90, "ry": 160, "value": 0.6, "feather": 40 }
] }
```

Gradient mask that fades an effect in from the top (y 0 = off, y 600 = on): `{ "type": "gradient", "from": [0,0], "to": [0,600] }`.
Vignette on a 1920x1080 canvas: `add_solid_layer` (black) then `add_effect {effect:"opacity", values:{alpha:0.85}, masks:{opacity:{shapes:[{"type":"radial","cx":960,"cy":540,"r":1150,"inner":0.4}], invert:true}}}`.
Global look: `add_effect_layer` then `add_effect` on it (`tint` with a colour + alpha 0.1-0.3, `chromaticaberration`, `filmgrain`, `godrays`, ...); it acts on everything below it.
Effect colours accept `"#rrggbb"`, `[r,g,b]` (0-1) or `"r g b"`.
Silhouette mask (effect only where the layer has pixels): `{ "from_layer": true, "blur": 6 }`.

Stacking: effects run in order on the result of the previous one (`#0` first). Put distortions (shake/waterwaves) before colour effects
(tint/pulse) and blur last.
