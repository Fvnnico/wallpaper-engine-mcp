import * as fs from "fs";
import * as path from "path";
import { MY_PROJECTS_PATH } from "../config";
import { resolveProject } from "../resolve";
import { backupProject } from "./backup";

export function deleteWallpaper(project: string): string {
  const projectDir = resolveProject(project);
  if (!projectDir) return `Project "${project}" not found.`;

  // Safety: only allow deleting from myprojects
  if (!projectDir.startsWith(MY_PROJECTS_PATH)) {
    return `Can only delete projects from myprojects. "${project}" is in a protected directory.`;
  }

  const b = backupProject(project, "deleted");   // deleting is otherwise irreversible
  fs.rmSync(projectDir, { recursive: true, force: true });
  return `Deleted project "${project}" at ${projectDir}. A copy was kept: restore_project {project:"${path.basename(projectDir)}", backup:"${b.id}"} brings it back.`;
}

export function deleteWallpaperFile(project: string, file: string): string {
  const projectDir = resolveProject(project);
  if (!projectDir) return `Project "${project}" not found.`;

  if (!projectDir.startsWith(MY_PROJECTS_PATH)) {
    return `Can only delete files from myprojects.`;
  }

  const filePath = path.join(projectDir, file);
  if (!filePath.startsWith(projectDir)) return "Invalid file path.";
  if (!fs.existsSync(filePath)) return `File "${file}" not found in project "${project}".`;

  fs.unlinkSync(filePath);
  return `Deleted "${file}" from project "${project}".`;
}
