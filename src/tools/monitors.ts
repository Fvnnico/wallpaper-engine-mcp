import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { WE_PATH } from "../config";

const read = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, "")); } catch { return undefined; } };

/** The Windows displays: name, primary, position and size in px. */
function screens(): Promise<{ n: string; p: boolean; x: number; y: number; w: number; h: number }[]> {
  const cmd = "Add-Type -AssemblyName System.Windows.Forms; @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ n = $_.DeviceName; p = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; w = $_.Bounds.Width; h = $_.Bounds.Height } }) | ConvertTo-Json -Compress";
  return new Promise(resolve => execFile("powershell", ["-NoProfile", "-Command", cmd], { windowsHide: true, timeout: 15000 }, (_e, out) => {
    try { const j = JSON.parse(String(out)); resolve(Array.isArray(j) ? j : [j]); } catch { resolve([]); }
  }));
}

/**
 * Displays and what each shows. Read-only: Wallpaper Engine rewrites config.json while it runs, so nothing here edits it
 * (playlists and profiles are opened by name with control_wallpaper). ponytail: WE's "MonitorN" numbering is assumed to follow the Windows display order.
 */
export async function listMonitors(): Promise<string> {
  const cfg = read(path.join(WE_PATH, "config.json"));
  const user: any = cfg && Object.values(cfg).find((v: any) => v?.general?.wallpaperconfig);
  const sel: Record<string, { file?: string }> = user?.general?.wallpaperconfig?.selectedwallpapers ?? {};
  const saved: Record<string, any> = user?.wproperties ?? {};
  const scr = await screens();
  const n = Math.max(scr.length, ...Object.keys(sel).map(k => Number(k.replace(/\D/g, "")) + 1));
  const lines = [`${scr.length} display(s). Wallpaper Engine numbers them Monitor0, Monitor1, ... (control_wallpaper monitor:N, apply_wallpaper monitor) and normally follows the Windows order below.`];
  for (let i = 0; i < n; i++) {
    const s = scr[i], file = sel["Monitor" + i]?.file;
    const title = file ? read(path.join(path.dirname(file), "project.json"))?.title : undefined;
    const ov = file ? saved[file]?.["Monitor" + i] : undefined;
    lines.push(`Monitor${i}: ${s ? `${s.n}${s.p ? " (primary)" : ""} ${s.w}x${s.h} at (${s.x},${s.y})` : "(not connected)"} - ${file ? `"${title ?? path.basename(path.dirname(file))}" ${file}` : "no wallpaper"}${ov ? `; viewer settings: ${JSON.stringify(ov)}` : ""}`);
  }
  lines.push("Not possible from here: creating playlists / profiles (WE owns config.json while running) and publishing to the Workshop (editor only).");
  return lines.join("\n");
}
