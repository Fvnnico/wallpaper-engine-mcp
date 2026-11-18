import * as fs from "fs";
import * as path from "path";
import { MY_PROJECTS_PATH, DEFAULT_PROJECTS_PATH, WORKSHOP_PATH } from "./config";

export function resolveProject(nameOrPath: string): string | null {
  if (path.isAbsolute(nameOrPath) && fs.existsSync(nameOrPath)) return nameOrPath;
  for (const dir of [MY_PROJECTS_PATH, DEFAULT_PROJECTS_PATH, WORKSHOP_PATH]) {
    if (!dir) continue;
    const full = path.join(dir, nameOrPath);
    if (fs.existsSync(full)) return full;
  }
  return null;
}
