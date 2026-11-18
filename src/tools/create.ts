import * as fs from "fs";
import * as path from "path";
import { MY_PROJECTS_PATH } from "../config";

type Template =
  | "blank"
  | "canvas-animation"
  | "css-animation"
  | "audio-reactive"
  | "image-parallax"
  | "slideshow"
  | "fps-aware-canvas";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function projectJson(
  title: string,
  description: string,
  extraProps?: Record<string, unknown>,
  flags?: { audio?: boolean }
): string {
  const props: Record<string, unknown> = {
    schemecolor: {
      order: 0,
      text: "Scheme color",
      type: "color",
      value: "0.2 0.6 1",
    },
    ...extraProps,
  };
  const general: Record<string, unknown> = { properties: props };
  if (flags?.audio) general.supportsaudioprocessing = true;

  return JSON.stringify(
    { title, description, file: "index.html", preview: "preview.jpg", type: "web", general },
    null,
    2
  );
}

const STYLE_COMMON = `* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
canvas { display: block; }
`;

const TEMPLATES: Record<Template, {
  html: string; css: string; js: string;
  extraProps?: Record<string, unknown>;
  flags?: { audio?: boolean };
}> = {
  blank: {
    html: `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head><body>
  <script src="script.js"></script>
</body></html>`,
    css: STYLE_COMMON,
    js: `// Your wallpaper code here\n`,
  },

  "canvas-animation": {
    html: `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head><body>
  <canvas id="c"></canvas>
  <script src="script.js"></script>
</body></html>`,
    css: STYLE_COMMON,
    js: `const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H;

function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

let schemeColor = [51, 153, 255];

window.wallpaperPropertyListener = {
  applyUserProperties(props) {
    if (props.schemecolor) {
      schemeColor = props.schemecolor.value.split(' ').map(v => Math.round(v * 255));
    }
  }
};

function draw(t) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
  ctx.fillRect(0, 0, W, H);

  const [r, g, b] = schemeColor;
  ctx.fillStyle = \`rgb(\${r}, \${g}, \${b})\`;
  const x = W / 2 + Math.cos(t / 1000) * 200;
  const y = H / 2 + Math.sin(t / 1000) * 200;
  ctx.beginPath();
  ctx.arc(x, y, 20, 0, Math.PI * 2);
  ctx.fill();

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
`,
  },

  "css-animation": {
    html: `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head><body>
  <div class="container">
    <div class="orb"></div>
  </div>
  <script src="script.js"></script>
</body></html>`,
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }

.container {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
}

.orb {
  width: 200px; height: 200px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--scheme) 0%, transparent 70%);
  animation: pulse 3s ease-in-out infinite;
  filter: blur(40px);
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 0.8; }
  50% { transform: scale(1.5); opacity: 1; }
}
`,
    js: `document.documentElement.style.setProperty('--scheme', 'rgb(51, 153, 255)');

window.wallpaperPropertyListener = {
  applyUserProperties(props) {
    if (props.schemecolor) {
      const c = props.schemecolor.value.split(' ').map(v => Math.round(v * 255));
      document.documentElement.style.setProperty('--scheme', \`rgb(\${c[0]}, \${c[1]}, \${c[2]})\`);
    }
  }
};
`,
  },

  "audio-reactive": {
    html: `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head><body>
  <canvas id="c"></canvas>
  <script src="script.js"></script>
</body></html>`,
    css: STYLE_COMMON,
    flags: { audio: true },
    js: `const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H;

function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

let schemeColor = [51, 153, 255];
let audioData = new Array(128).fill(0);

window.wallpaperPropertyListener = {
  applyUserProperties(props) {
    if (props.schemecolor) {
      schemeColor = props.schemecolor.value.split(' ').map(v => Math.round(v * 255));
    }
  }
};

function wallpaperAudioListener(audioArray) {
  // 128 floats (0-1). 0-63 = left channel, 64-127 = right channel.
  // Low index = bass, high index = treble.
  audioData = Array.from(audioArray);
}
window.wallpaperRegisterAudioListener(wallpaperAudioListener);

function draw() {
  ctx.clearRect(0, 0, W, H);

  const barW = W / 64;
  const [r, g, b] = schemeColor;

  for (let i = 0; i < 64; i++) {
    const val = Math.min(audioData[i] || 0, 1);
    const h = val * H * 0.8;
    ctx.fillStyle = \`rgba(\${r}, \${g}, \${b}, \${0.4 + val * 0.6})\`;
    ctx.fillRect(i * barW, H - h, barW - 2, h);
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
`,
  },

  "image-parallax": {
    html: `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head><body>
  <div id="parallax-container">
    <img id="bg" src="images/background.png" alt="">
  </div>
  <script src="script.js"></script>
</body></html>`,
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }

#parallax-container {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}

#bg {
  min-width: 110%; min-height: 110%;
  object-fit: cover;
  transition: transform 0.15s ease-out;
  will-change: transform;
}
`,
    extraProps: {
      parallaxstrength: {
        order: 1, text: "Parallax strength", type: "slider",
        min: 0, max: 50, value: 15, fraction: true, step: 1,
      },
      customimage: {
        order: 2, text: "Custom image", type: "file",
        fileType: "image",
      },
    },
    js: `const bg = document.getElementById('bg');
let parallaxStrength = 15;

document.addEventListener('mousemove', (e) => {
  const xOff = (e.clientX / window.innerWidth - 0.5) * parallaxStrength;
  const yOff = (e.clientY / window.innerHeight - 0.5) * parallaxStrength;
  bg.style.transform = \`translate(\${-xOff}px, \${-yOff}px)\`;
});

window.wallpaperPropertyListener = {
  applyUserProperties(props) {
    if (props.schemecolor) {
      // scheme color available for taskbar tinting
    }
    if (props.parallaxstrength) {
      parallaxStrength = props.parallaxstrength.value;
    }
    if (props.customimage) {
      if (props.customimage.value) {
        bg.src = 'file:///' + props.customimage.value;
      }
    }
  }
};
`,
  },

  slideshow: {
    html: `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head><body>
  <div id="slideshow">
    <img id="current" src="" alt="">
    <img id="next" src="" alt="">
  </div>
  <script src="script.js"></script>
</body></html>`,
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }

#slideshow { width: 100%; height: 100%; position: relative; }

#slideshow img {
  position: absolute; top: 0; left: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  transition: opacity 1.5s ease-in-out;
}

#next { opacity: 0; }
`,
    extraProps: {
      imagedirectory: {
        order: 1, text: "Image folder", type: "directory",
        mode: "ondemand", fileType: "image",
      },
      interval: {
        order: 2, text: "Slide interval (sec)", type: "slider",
        min: 3, max: 60, value: 10, fraction: false, step: 1,
      },
    },
    js: `const current = document.getElementById('current');
const next = document.getElementById('next');
let interval = 10;
let dirReady = false;

function loadNext() {
  if (!dirReady) return;
  window.wallpaperRequestRandomFileForProperty('imagedirectory', (propName, filePath) => {
    if (!filePath) return;
    next.src = 'file:///' + filePath;
    next.onload = () => {
      next.style.opacity = '1';
      setTimeout(() => {
        current.src = next.src;
        next.style.opacity = '0';
      }, 1600);
    };
  });
}

setInterval(() => loadNext(), interval * 1000);

window.wallpaperPropertyListener = {
  applyUserProperties(props) {
    if (props.imagedirectory) {
      dirReady = !!props.imagedirectory.value;
      if (dirReady) loadNext();
    }
    if (props.interval) {
      interval = props.interval.value;
    }
  }
};
`,
  },

  "fps-aware-canvas": {
    html: `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="style.css">
</head><body>
  <canvas id="c"></canvas>
  <script src="script.js"></script>
</body></html>`,
    css: STYLE_COMMON,
    js: `const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H;

function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// --- FPS limiter (from WE docs) ---
let fpsLimit = 0;
let last = performance.now() / 1000;
let fpsThreshold = 0;

let schemeColor = [51, 153, 255];
let paused = false;

window.wallpaperPropertyListener = {
  applyUserProperties(props) {
    if (props.schemecolor) {
      schemeColor = props.schemecolor.value.split(' ').map(v => Math.round(v * 255));
    }
  },
  applyGeneralProperties(props) {
    if (props.fps) fpsLimit = props.fps;
  },
  setPaused(isPaused) {
    paused = isPaused;
  }
};

function run() {
  requestAnimationFrame(run);
  if (paused) return;

  const now = performance.now() / 1000;
  const dt = Math.min(now - last, 1);
  last = now;

  if (fpsLimit > 0) {
    fpsThreshold += dt;
    if (fpsThreshold < 1.0 / fpsLimit) return;
    fpsThreshold -= 1.0 / fpsLimit;
  }

  // --- Draw (replace with your animation) ---
  ctx.fillStyle = 'rgba(0, 0, 0, 0.03)';
  ctx.fillRect(0, 0, W, H);

  const [r, g, b] = schemeColor;
  const t = performance.now();
  for (let i = 0; i < 5; i++) {
    const angle = (t / 2000) + (i * Math.PI * 2 / 5);
    const x = W / 2 + Math.cos(angle) * 200;
    const y = H / 2 + Math.sin(angle) * 200;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fillStyle = \`rgba(\${r}, \${g}, \${b}, 0.8)\`;
    ctx.fill();
  }
}

requestAnimationFrame(run);
`,
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as Template[];

export function createWallpaper(
  name?: string,
  title?: string,
  description?: string,
  template?: string
): string {
  const t = (template as Template) || "blank";
  if (!(t in TEMPLATES)) {
    return `Unknown template "${t}". Available: ${TEMPLATE_NAMES.join(", ")}`;
  }

  const finalTitle = title || name || "My Wallpaper";
  const folderName = name ? slugify(name) : slugify(finalTitle);
  const dir = path.join(MY_PROJECTS_PATH, folderName);

  if (fs.existsSync(dir)) {
    return `Project folder "${folderName}" already exists at ${dir}`;
  }

  fs.mkdirSync(dir, { recursive: true });

  const tmpl = TEMPLATES[t];
  fs.writeFileSync(
    path.join(dir, "project.json"),
    projectJson(finalTitle, description || "", tmpl.extraProps, tmpl.flags)
  );
  fs.writeFileSync(path.join(dir, "index.html"), tmpl.html);
  fs.writeFileSync(path.join(dir, "style.css"), tmpl.css);
  fs.writeFileSync(path.join(dir, "script.js"), tmpl.js);

  // Create images/ subdir for templates that reference it
  if (t === "image-parallax") {
    fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  }

  return [
    `Created web wallpaper "${finalTitle}" at:`,
    dir,
    "",
    "Files:",
    "  project.json",
    "  index.html",
    "  style.css",
    "  script.js",
    ...(t === "image-parallax" ? ["  images/  (put your image here, or use import_image tool)"] : []),
    "",
    `Template: ${t}`,
    "",
    "Next steps: use write_wallpaper_file to edit code, import_image to add images, then apply_wallpaper to preview.",
  ].join("\n");
}
