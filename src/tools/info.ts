import * as fs from "fs";
import * as path from "path";
import { resolveProject } from "../resolve";

function fileTree(dir: string, prefix = ""): string[] {
  const lines: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      lines.push(`${prefix}${entry.name}/`);
      lines.push(...fileTree(path.join(dir, entry.name), prefix + "  "));
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }
  return lines;
}

export function getWallpaperInfo(nameOrPath: string): string {
  const projectDir = resolveProject(nameOrPath);
  if (!projectDir) return `Wallpaper "${nameOrPath}" not found.`;

  const projFile = path.join(projectDir, "project.json");
  let projJson = "(no project.json)";
  if (fs.existsSync(projFile)) {
    projJson = fs.readFileSync(projFile, "utf-8");
  }

  const tree = fileTree(projectDir);

  return [
    `Path: ${projectDir}`,
    "",
    "## project.json",
    projJson,
    "",
    "## Files",
    ...tree,
  ].join("\n");
}
