import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import { resolveProject } from "../resolve";
import { applyWallpaper } from "./apply";
import type { ToolOutput } from "./preview";

/*
 * Reads a Wallpaper Engine pop-out window with PrintWindow(PW_RENDERFULLCONTENT): the compositor hands back the real GPU output even when
 * the window sits behind other windows (verified on WE 2.8 with effects and animation). Only the client area is kept.
 * Parameters come through environment variables so the script needs no quoting.
 */
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class WEPW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
}
'@
$p = Get-Process | Where-Object { $_.ProcessName -like 'wallpaper*' -and $_.MainWindowTitle -eq $env:WE_TITLE } | Select-Object -First 1
if (-not $p) { [Console]::Error.WriteLine('window not found'); exit 2 }
$h = [IntPtr]$p.MainWindowHandle
$moved = $false
$sw = [Diagnostics.Stopwatch]::StartNew()
if ($env:WE_CX) {
  # fractions of the client area -> screen point
  $cr0 = New-Object WEPW+RECT; [void][WEPW]::GetClientRect($h, [ref]$cr0)
  $t = New-Object WEPW+POINT; [void][WEPW]::ClientToScreen($h, [ref]$t)
  $t.X += [int]($cr0.R * [double]$env:WE_CX); $t.Y += [int]($cr0.B * [double]$env:WE_CY)
  if ($env:WE_CLICK -eq '1') {
    # a click lands on whatever window is under the cursor: bring the target up (Alt unlocks SetForegroundWindow) and refuse if something still covers that spot
    [WEPW]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [void][WEPW]::SetForegroundWindow($h); [WEPW]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    if ([WEPW]::GetAncestor([WEPW]::WindowFromPoint($t), 2) -ne $h) { [Console]::Error.WriteLine('covered'); exit 3 }
  }
  $old = New-Object WEPW+POINT; [void][WEPW]::GetCursorPos([ref]$old); $moved = $true
  [void][WEPW]::SetCursorPos($t.X, $t.Y); Start-Sleep -Milliseconds 100
  if ($env:WE_CLICK -eq '1') { $sw.Restart(); [WEPW]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [WEPW]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
}
try { for ($i = 0; $i -lt [int]$env:WE_FRAMES; $i++) {
  if ($i -gt 0) { Start-Sleep -Milliseconds ([int]$env:WE_INTERVAL) }
  $wr = New-Object WEPW+RECT; [void][WEPW]::GetWindowRect($h, [ref]$wr)
  $cr = New-Object WEPW+RECT; [void][WEPW]::GetClientRect($h, [ref]$cr)
  $pt = New-Object WEPW+POINT; [void][WEPW]::ClientToScreen($h, [ref]$pt)
  [Console]::Out.WriteLine($sw.ElapsedMilliseconds)
  $bw = $wr.R - $wr.L; $bh = $wr.B - $wr.T
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $bw, $bh
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  [void][WEPW]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle -ArgumentList ($pt.X - $wr.L), ($pt.Y - $wr.T), $cr.R, $cr.B
  $crop = $bmp.Clone($rect, $bmp.PixelFormat)
  $crop.Save((Join-Path $env:WE_OUT ('f' + $i + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose(); $bmp.Dispose()
} } finally { if ($moved) { [void][WEPW]::SetCursorPos($old.X, $old.Y) } }
`;
const PS_B64 = Buffer.from(PS, "utf16le").toString("base64");

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** cursor in fractions 0..1 of the window's client area; the real mouse is moved there for the capture and put back afterwards */
interface Pointer { x: number; y: number; click: boolean }

/** `times`: ms at which each frame was taken, counted from the click (or from the start of the capture without one) */
interface Shots { shots: Buffer[]; times: number[] }

function grab(title: string, frames: number, intervalMs: number, ptr?: Pointer): Promise<Shots> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "we-capture-"));
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", PS_B64],
      { env: { ...process.env, WE_TITLE: title, WE_OUT: out, WE_FRAMES: String(frames), WE_INTERVAL: String(intervalMs), WE_CX: ptr ? String(ptr.x) : "", WE_CY: ptr ? String(ptr.y) : "", WE_CLICK: ptr?.click ? "1" : "" }, timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        try {
          const code = (err as any)?.code;
          if (code === 3) throw new Error(`Another window covers the click point of "${title}" and could not be brought to the front, so no click was sent (it would have hit that window). Move or minimise what covers it, or click somewhere else.`);
          if (err) throw new Error(code === 2 ? `Window "${title}" not found. Pass project to open it, or apply_wallpaper with window:{name:"${title}"} first.` : `Capture failed: ${String(stderr || err.message).trim()}`);
          const ts = String(stdout).split(/\r?\n/).filter(Boolean).map(Number);
          resolve({
            shots: Array.from({ length: frames }, (_, i) => fs.readFileSync(path.join(out, `f${i}.png`))),
            times: Array.from({ length: frames }, (_, i) => ts[i] ?? i * intervalMs),
          });
        } catch (e) { reject(e); } finally { fs.rmSync(out, { recursive: true, force: true }); }
      });
  });
}

/** Pure black = the window had not rendered yet. */
async function isBlank(png: Buffer): Promise<boolean> {
  return (await sharp(png).stats()).channels.slice(0, 3).every(c => c.max <= 3);
}

/** One JPEG: the single frame, or a 2-column filmstrip labelled with the capture time. */
async function filmstrip(shots: Buffer[], times: number[], width: number): Promise<Buffer> {
  if (shots.length === 1) return sharp(shots[0]).resize({ width }).jpeg({ quality: 88 }).toBuffer();
  const cols = 2, tw = Math.floor(width / cols);
  const tiles = await Promise.all(shots.map(b => sharp(b).resize({ width: tw }).png().toBuffer()));
  const th = (await sharp(tiles[0]).metadata()).height ?? 1;
  const label = (i: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><text x="8" y="24" font-size="20" font-family="Arial" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">t = ${(times[i] / 1000).toFixed(2)} s</text></svg>`);
  const at = (i: number) => ({ left: (i % cols) * tw, top: Math.floor(i / cols) * th });
  return sharp({ create: { width: cols * tw, height: Math.ceil(shots.length / cols) * th, channels: 3, background: "#000" } })
    .composite(tiles.flatMap((t, i) => [{ input: t, ...at(i) }, { input: label(i), ...at(i) }]))
    .jpeg({ quality: 88 }).toBuffer();
}

export interface CaptureArgs {
  project?: string; window?: string; width?: number; height?: number;
  wait_ms?: number; frames?: number; interval_ms?: number; output_width?: number;
  /** zoom into a part of the window, as fractions 0..1 of its width/height */
  crop?: { x: number; y: number; w: number; h: number };
  /** put the mouse here (fractions 0..1 of the window) before the first frame */
  cursor?: { x: number; y: number };
  /** press the left button at `cursor` (window centre when omitted) right before the first frame */
  click?: boolean;
  /** user property values for this capture only (needs `project`; project.json is restored afterwards) */
  properties?: Record<string, unknown>;
}

/**
 * Write `values` into the default `value` of project.json's user properties; returns the function that puts the original bytes back.
 * ponytail: temporary edit of the file instead of a live applyProperties (which targets the desktop wallpaper, not the pop-out); a crash before restore leaves the values changed.
 */
export function overrideProperties(dir: string, values: Record<string, unknown>): () => void {
  const file = path.join(dir, "project.json"), raw = fs.readFileSync(file);
  const pj = JSON.parse(raw.toString("utf-8").replace(/^\uFEFF/, ""));
  const props = pj.general?.properties ?? {};
  for (const [k, v] of Object.entries(values)) {
    if (!props[k]) throw new Error(`Unknown property "${k}". Defined: ${Object.keys(props).join(", ") || "(none)"}.`);
    props[k].value = v;
  }
  fs.writeFileSync(file, JSON.stringify(pj, null, "\t"));
  return () => fs.writeFileSync(file, raw);
}

export async function captureWallpaper(a: CaptureArgs): Promise<ToolOutput> {
  if (process.platform !== "win32") throw new Error("capture_wallpaper works on Windows only (Wallpaper Engine's platform).");
  const title = a.window ?? "mcp_preview";
  const lines: string[] = [];
  const set = a.properties && Object.keys(a.properties).length ? a.properties : undefined;
  if (set && !a.project) throw new Error("properties needs project: the wallpaper is reloaded to apply them.");
  const dir = set ? resolveProject(a.project!) : null;
  if (set && !dir) throw new Error(`Project "${a.project}" not found.`);
  const restore = set ? overrideProperties(dir!, set) : undefined;
  const ptr: Pointer | undefined = a.cursor || a.click ? { x: clamp(a.cursor?.x ?? 0.5, 0, 1), y: clamp(a.cursor?.y ?? 0.5, 0, 1), click: !!a.click } : undefined;
  let shots: Buffer[], times: number[];
  const frames = clamp(Math.round(a.frames ?? 1), 1, 8), iv = clamp(a.interval_ms ?? 500, 0, 5000);
  try {
    if (a.project) {
      const r = await applyWallpaper({ project: a.project, window: { name: title, width: a.width ?? 1280, height: a.height ?? 720, x: 80, y: 60 } });
      if (!/Applied "/.test(r)) throw new Error(r);
      lines.push(r.split("\n")[0]);
      await sleep(clamp(a.wait_ms ?? 4500, 0, 60000));
    }
    ({ shots, times } = await grab(title, frames, iv, ptr));
    // a freshly opened scene can need a few more seconds to load: look again instead of returning a black frame
    for (let retry = 0; retry < 3 && a.project && await isBlank(shots[0]); retry++) { await sleep(2500); ({ shots, times } = await grab(title, frames, iv, ptr)); }
  } finally { restore?.(); }
  if (set) lines.push(`Properties for this capture only: ${Object.entries(set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")} (project.json restored).`);
  if (ptr) lines.push(`Mouse at ${(ptr.x * 100).toFixed(0)}%, ${(ptr.y * 100).toFixed(0)}% of the window${ptr.click ? ", clicked right before the first frame" : ""} (put back afterwards).`);
  if (a.crop) {
    const m0 = await sharp(shots[0]).metadata(), W = m0.width!, H = m0.height!, c = a.crop;
    const box = { left: clamp(Math.round(c.x * W), 0, W - 2), top: clamp(Math.round(c.y * H), 0, H - 2), width: 0, height: 0 };
    box.width = clamp(Math.round(c.w * W), 2, W - box.left); box.height = clamp(Math.round(c.h * H), 2, H - box.top);
    shots = await Promise.all(shots.map(s => sharp(s).extract(box).png().toBuffer()));
  }
  const meta = await sharp(shots[0]).metadata();
  lines.push(`Captured ${frames} frame${frames > 1 ? `s (filmstrip, t = seconds ${ptr?.click ? "after the click" : "from the start"})` : ""} of the real Wallpaper Engine window "${title}" (${meta.width}x${meta.height}). Effects, particles, post-process and animation are rendered by the engine.`);
  if (await isBlank(shots[0])) lines.push("The frame is completely black: the wallpaper may still be loading (raise wait_ms) or the scene really is black (validate_project).");
  return { text: lines.join("\n"), images: [{ data: await filmstrip(shots, times, clamp(a.output_width ?? 1280, 320, 2560)), mime: "image/jpeg" }] };
}
