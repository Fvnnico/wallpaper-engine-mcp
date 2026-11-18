import * as fs from "fs";
import * as path from "path";
import { resolveProject } from "../resolve";

export function readWallpaperFile(project: string, file: string): string {
  const projectDir = resolveProject(project);
  if (!projectDir) return `Project "${project}" not found.`;

  const filePath = path.join(projectDir, file);
  if (!filePath.startsWith(projectDir)) return "Invalid file path.";
  if (!fs.existsSync(filePath)) return `File "${file}" not found in project "${project}".`;

  return fs.readFileSync(filePath, "utf-8");
}
