import * as fs from "fs";
import * as path from "path";
import { resolveProject } from "../resolve";

export function writeWallpaperFile(project: string, file: string, content: string): string {
  const projectDir = resolveProject(project);
  if (!projectDir) return `Project "${project}" not found.`;

  const filePath = path.join(projectDir, file);
  if (!filePath.startsWith(projectDir)) return "Invalid file path.";

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(filePath, content, "utf-8");
  return `Wrote ${content.length} bytes to ${file} in project "${project}".`;
}
