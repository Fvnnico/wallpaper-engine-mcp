import { WE_PATH, MY_PROJECTS_PATH, WORKSHOP_PATH } from "./config";

/* Resource texts served over MCP (we://...). */

export const API_REFERENCE = `# Wallpaper Engine Web Wallpaper API Reference
(Based on official docs: https://docs.wallpaperengine.io)

## Paths on this system
- Wallpaper Engine install: ${WE_PATH}
- User projects: ${MY_PROJECTS_PATH}
- Workshop wallpapers: ${WORKSHOP_PATH ?? "(not found)"}

## Overview
Web wallpapers are HTML/CSS/JS pages rendered by Wallpaper Engine's embedded Chromium (CEF).
The entry point is defined in project.json \`"file"\` field (usually "index.html").
Only .webm, .ogg and .ogv video files are supported inside web wallpapers.
Always bundle JS libraries locally — don't rely on CDN.

## project.json structure
\`\`\`json
{
  "title": "My Wallpaper",
  "description": "...",
  "file": "index.html",
  "preview": "preview.jpg",
  "type": "web",
  "general": {
    "properties": { ... },
    "supportsaudioprocessing": true
  }
}
\`\`\`

## User Property types (in project.json general.properties)

### color
\`\`\`json
"mycolor": { "order": 0, "text": "My Color", "type": "color", "value": "1 0.5 0.2" }
\`\`\`
Value = three space-separated floats 0-1 (RGB). Convert to 0-255 via \`Math.ceil(v * 255)\`.

### slider
\`\`\`json
"speed": { "order": 1, "text": "Speed", "type": "slider", "min": 0.1, "max": 5, "value": 1, "fraction": true, "step": 0.1, "precision": 2 }
\`\`\`
Set "fraction": true for decimals. "precision" controls decimal places (default 2).

### bool (checkbox)
\`\`\`json
"showtext": { "order": 2, "text": "Show Text", "type": "bool", "value": true }
\`\`\`

### combo (dropdown)
\`\`\`json
"style": { "order": 3, "text": "Style", "type": "combo", "value": "waves",
  "options": [
    { "label": "Waves", "value": "waves" },
    { "label": "Particles", "value": "particles" }
  ]
}
\`\`\`

### textinput
\`\`\`json
"greeting": { "order": 4, "text": "Greeting", "type": "textinput", "value": "Hello World" }
\`\`\`

### file (image or video picker)
\`\`\`json
"customimage": { "order": 5, "text": "Custom Image", "type": "file", "fileType": "image" }
\`\`\`
fileType: "image" (.jpeg, .jpg, .png, .pnga, .bmp, .gif, .svg, .webp) or "video" (.webm, .ogg, .ogv).
In JS, prepend "file:///" to the value: \`'file:///' + props.customimage.value\`

### directory (mass import images/videos)
\`\`\`json
"imagedir": { "order": 6, "text": "Image Folder", "type": "directory", "mode": "ondemand", "fileType": "image" }
\`\`\`
Modes:
- "ondemand": use \`window.wallpaperRequestRandomFileForProperty('imagedir', callback)\` to get one random file.
- "fetchall": use \`userDirectoryFilesAddedOrChanged\` and \`userDirectoryFilesRemoved\` events.

### Conditional visibility
\`\`\`json
"detailcolor": { "type": "color", "value": "1 0 0", "condition": "showdetails.value == true" }
\`\`\`

## JavaScript APIs

### wallpaperPropertyListener
IMPORTANT: Initialize as a global object outside of any events (NOT inside window.onload).

\`\`\`js
window.wallpaperPropertyListener = {
  applyUserProperties(properties) {
    // Fired when user changes properties OR on first load (all props at once).
    // Always check if each property exists — only changed props are included on updates.
    if (properties.mycolor) {
      var rgb = properties.mycolor.value.split(' ').map(c => Math.ceil(c * 255));
      // rgb = [255, 128, 51]
    }
    if (properties.speed) {
      var speed = properties.speed.value; // number
    }
    if (properties.style) {
      var style = properties.style.value; // string
    }
    if (properties.showtext) {
      var show = properties.showtext.value; // boolean
    }
    if (properties.customimage) {
      if (properties.customimage.value) {
        someImg.src = 'file:///' + properties.customimage.value;
      }
    }
  },

  applyGeneralProperties(properties) {
    // Fired when user changes WE app settings (mainly FPS limit).
    if (properties.fps) {
      // Apply FPS limit — see FPS limiter section below.
    }
  },

  setPaused(isPaused) {
    // WE freezes the process anyway, but you can react to pause/unpause.
  },

  // For "fetchall" directory properties:
  userDirectoryFilesAddedOrChanged(propertyName, changedFiles) {
    // changedFiles = array of full file paths added/modified
  },
  userDirectoryFilesRemoved(propertyName, removedFiles) {
    // removedFiles = array of full file paths removed
  }
};
\`\`\`

### Audio Listener
Requires \`"supportsaudioprocessing": true\` in project.json general section.
Register ONCE, outside window.onload, ideally at end of <body>.

\`\`\`js
function wallpaperAudioListener(audioArray) {
  // audioArray: 128 floats, roughly 0.0 to 1.0 (can spike above 1.0 — use Math.min).
  // Index 0-63: LEFT channel (0 = lowest bass, 63 = highest treble)
  // Index 64-127: RIGHT channel (64 = lowest bass, 127 = highest treble)

  // Example: average bass (first 8 bins)
  var bass = 0;
  for (var i = 0; i < 8; i++) bass += Math.min(audioArray[i], 1);
  bass /= 8;
}
window.wallpaperRegisterAudioListener(wallpaperAudioListener);
\`\`\`
Called ~30 times per second when audio is playing.

### Random file from directory property (ondemand mode)
\`\`\`js
function onRandomFile(propertyName, filePath) {
  someImg.src = 'file:///' + filePath;
}
window.wallpaperRequestRandomFileForProperty('imagedir', onRandomFile);
\`\`\`

## FPS Limiter (from official docs)
Always respect the user's FPS setting from applyGeneralProperties.

\`\`\`js
var wallpaperSettings = { fps: 0 };
var last = performance.now() / 1000;
var fpsThreshold = 0;

window.wallpaperPropertyListener = {
  applyGeneralProperties(properties) {
    if (properties.fps) wallpaperSettings.fps = properties.fps;
  }
};

function run() {
  requestAnimationFrame(run);
  var now = performance.now() / 1000;
  var dt = Math.min(now - last, 1);
  last = now;
  if (wallpaperSettings.fps > 0) {
    fpsThreshold += dt;
    if (fpsThreshold < 1.0 / wallpaperSettings.fps) return;
    fpsThreshold -= 1.0 / wallpaperSettings.fps;
  }
  // --- Your draw code here ---
}
requestAnimationFrame(run);
\`\`\`

## RGB Hardware LED Support
Control Corsair iCUE, Razer Chroma, etc. from your wallpaper.

\`\`\`js
var ledPluginLoaded = false;

window.wallpaperPluginListener = {
  onPluginLoaded(name, version) {
    if (name === 'led') ledPluginLoaded = true;
    // if (name === 'cue') { /* Corsair-specific extras */ }
  }
};

// In your render loop, send canvas data to all LED devices:
if (ledPluginLoaded) {
  var ctx = rgbCanvas.getContext('2d');
  var imageData = ctx.getImageData(0, 0, rgbCanvas.width, rgbCanvas.height);
  var colorArray = [];
  for (var d = 0; d < imageData.data.length; d += 4) {
    var w = d / 4 * 3;
    colorArray[w] = imageData.data[d];
    colorArray[w + 1] = imageData.data[d + 1];
    colorArray[w + 2] = imageData.data[d + 2];
  }
  var encoded = String.fromCharCode.apply(null, colorArray);
  window.wpPlugins.led.setAllDevicesByImageData(encoded, rgbCanvas.width, rgbCanvas.height);
}
\`\`\`
Use a small canvas (e.g. 100x20 pixels) for LED data to minimize performance impact.

## Debugging
1. Open WE Settings > General > set "CEF devtools port" to 8080.
2. Open Chrome and navigate to \`localhost:8080\`.
3. Click on your wallpaper's main file to inspect with full Chrome DevTools.

## Tips
1. Use requestAnimationFrame (with FPS limiter) for smooth animations.
2. Canvas 2D, WebGL, CSS animations, Three.js, p5.js all work — bundle locally.
3. Viewport = full monitor resolution. Always handle resize for multi-monitor.
4. Background should default to black (#000) for seamless loading.
5. Avoid heavy DOM manipulation — prefer canvas or WebGL.
6. "schemecolor" is a WE convention — it tints the Windows taskbar accent color.
7. Don't use window.onload for WE-specific code — register listeners at script load time.
8. Video files inside web wallpapers: only .webm, .ogg, .ogv supported.
9. File property images must be prefixed with \`file:///\` to load in CEF.
10. Math.min(audioArray[i], 1) — audio values can rarely spike above 1.0.
`;

import * as fs from "fs";
import * as path from "path";

/** Markdown guides live in ../docs so they can be read and edited like normal files. */
const readDoc = (f: string): string => {
  try { return fs.readFileSync(path.join(__dirname, "..", "docs", f), "utf-8"); } catch { return `(docs/${f} not found next to the server)`; }
};
export const sceneGuide = () => readDoc("scene-guide.md");
export const effectsCookbook = () => readDoc("effects-cookbook.md");
