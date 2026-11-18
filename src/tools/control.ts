import { execFile, spawn } from "child_process";
import { WE_EXE } from "../config";

/** Run wallpaper32.exe with arguments; resolves with stdout (getWallpaper prints the path there). */
export function runWE(args: string[], timeout = 8000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(WE_EXE, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: `wallpaper32.exe error: ${err.message}${stderr ? "\n" + stderr : ""}` });
      else resolve({ ok: true, out: String(stdout ?? "").trim() });
    });
  });
}

function isRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(!err && /"wallpaper(32|64)\.exe"/i.test(String(stdout)));
    });
  });
}

/** The CLI only talks to a running instance: start Wallpaper Engine when needed and give it time to come up. */
export async function ensureRunning(): Promise<string> {
  if (await isRunning()) return "";
  spawn(WE_EXE, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 1000)); if (await isRunning()) { await new Promise(r => setTimeout(r, 4000)); return "Wallpaper Engine was not running and has been started. "; } }
  return "Wallpaper Engine did not start in time. ";
}

export type ControlAction = "pause" | "stop" | "play" | "mute" | "unmute" | "next" | "close" | "open_playlist" | "open_profile" | "apply_properties" | "hide_icons" | "show_icons" | "get_wallpaper";

export interface ControlArgs {
  action: ControlAction;
  monitor?: number;
  playlist?: string;
  profile?: string;
  /** for apply_properties: { "<propertyKey>": value }, e.g. { "rain": true, "schemecolor": "1 0 0" } */
  properties?: Record<string, unknown>;
}

const SIMPLE: Record<string, string> = { pause: "pause", stop: "stop", play: "play", mute: "mute", unmute: "unmute", hide_icons: "hideIcons", show_icons: "showIcons" };

export async function controlWallpaper(a: ControlArgs): Promise<string> {
  const started = await ensureRunning();
  const mon = a.monitor !== undefined ? ["-monitor", String(a.monitor)] : [];
  let args: string[];
  if (SIMPLE[a.action]) args = ["-control", SIMPLE[a.action]];
  else if (a.action === "next") args = ["-control", "nextWallpaper", ...mon];
  else if (a.action === "close") args = ["-control", "closeWallpaper", ...mon];
  else if (a.action === "get_wallpaper") args = ["-control", "getWallpaper", ...mon];
  else if (a.action === "open_playlist") {
    if (!a.playlist) return "playlist is required for open_playlist (name of a playlist saved in Wallpaper Engine).";
    args = ["-control", "openPlaylist", "-playlist", a.playlist, ...mon];
  } else if (a.action === "open_profile") {
    if (!a.profile) return "profile is required for open_profile (name of a profile saved in the display menu).";
    args = ["-control", "openProfile", "-profile", a.profile];
  } else if (a.action === "apply_properties") {
    if (!a.properties || !Object.keys(a.properties).length) return "properties is required for apply_properties, e.g. { \"rain\": true }.";
    args = ["-control", "applyProperties", "-properties", `RAW~(${JSON.stringify(a.properties)})~END`, ...mon];
  } else return `Unknown action "${a.action}".`;
  const r = await runWE(args);
  if (!r.ok) return started + r.out;
  return `${started}Executed ${a.action}${r.out ? `: ${r.out}` : ""}`;
}
