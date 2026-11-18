import * as fs from "fs";
import * as path from "path";
import {
  MY_PROJECTS_PATH,
  DEFAULT_PROJECTS_PATH,
  WORKSHOP_PATH,
} from "../config";

interface WallpaperEntry {
  name: string;
  title: string;
  type: string;
  category: string;
  path: string;
}

const CATEGORY_DIRS: Record<string, string | null> = {
  myprojects: MY_PROJECTS_PATH,
  default: DEFAULT_PROJECTS_PATH,
  workshop: WORKSHOP_PATH,
};

function scanCategory(category: string, dir: string): WallpaperEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: WallpaperEntry[] = [];

  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const projFile = path.join(full, "project.json");
    if (!fs.existsSync(projFile)) continue;

    try {
      const proj = JSON.parse(fs.readFileSync(projFile, "utf-8"));
      entries.push({
        name,
        title: proj.title ?? name,
        type: proj.type ?? "scene",
        category,
        path: full,
      });
    } catch {
      entries.push({ name, title: name, type: "unknown", category, path: full });
    }
  }
  return entries;
}

export function listWallpapers(category?: string): string {
  const cats =
    !category || category === "all"
      ? Object.keys(CATEGORY_DIRS)
      : [category];

  const results: WallpaperEntry[] = [];
  for (const cat of cats) {
    const dir = CATEGORY_DIRS[cat];
    if (dir) results.push(...scanCategory(cat, dir));
  }

  if (results.length === 0) return "No wallpapers found.";

  const lines = results.map(
    (w) => `[${w.category}] ${w.title} (${w.type}) — ${w.name}\n  ${w.path}`
  );
  return `Found ${results.length} wallpaper(s):\n\n${lines.join("\n\n")}`;
}
