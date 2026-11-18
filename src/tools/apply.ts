import * as fs from "fs";
import * as path from "path";
import { resolveProject } from "../resolve";
import { ensureRunning, runWE } from "./control";

/** Scenes are opened through project.json (as the docs recommend); web/video through their entry file. */
function findEntryFile(projectDir: string): string | null {
  const projFile = path.join(projectDir, "project.json");
  if (fs.existsSync(projFile)) {
    try {
      const proj = JSON.parse(fs.readFileSync(projFile, "utf-8").replace(/^\uFEFF/, ""));
      if (proj.type === "scene") return projFile;
      if (proj.file && fs.existsSync(path.join(projectDir, proj.file))) return path.join(projectDir, proj.file);
    } catch { /* fall through */ }
    return projFile;
  }
  for (const f of ["index.html", "scene.json"]) {
    const full = path.join(projectDir, f);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export interface ApplyArgs {
  project: string;
  monitor?: number;
  /** open in a floating window instead of the desktop */
  window?: { name?: string; width?: number; height?: number; x?: number; y?: number; borderless?: boolean };
  /** name of a saved local preset (property set) of this wallpaper */
  preset?: string;
}

export async function applyWallpaper(a: ApplyArgs): Promise<string> {
  const projectDir = resolveProject(a.project);
  if (!projectDir) return `Project "${a.project}" not found.`;
  const entry = findEntryFile(projectDir);
  if (!entry) return `No entry file found in "${a.project}".`;
  const started = await ensureRunning();
  const args = ["-control", "openWallpaper", "-file", entry];
  if (a.window) {
    args.push("-playInWindow", a.window.name ?? "Wallpaper Pop-out");
    for (const [k, v] of [["width", a.window.width], ["height", a.window.height], ["x", a.window.x], ["y", a.window.y]] as const) if (v !== undefined) args.push(`-${k}`, String(v));
    if (a.window.borderless) args.push("-borderless");
  } else args.push("-monitor", String(a.monitor ?? 0));
  if (a.preset) args.push("-preset", a.preset);
  const r = await runWE(args);
  if (!r.ok) return started + r.out;
  return `${started}Applied "${a.project}" ${a.window ? `in window "${a.window.name ?? "Wallpaper Pop-out"}"` : `to monitor ${a.monitor ?? 0}`}.\nFile: ${entry}\nIf the wallpaper looks wrong, call validate_project and preview_scene; reapplying reloads the files from disk.`;
}
