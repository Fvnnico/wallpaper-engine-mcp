import * as fs from "fs";
import * as path from "path";
import { MY_PROJECTS_PATH, PROJECTS_PATH } from "../config";
import { resolveProject } from "../resolve";

/** Outside myprojects, so Wallpaper Engine does not list the copies as wallpapers. Layout: mcp_backups/<project>/<YYYYMMDD-HHMMSSmmm>[_note]/ */
export const BACKUPS_PATH = path.join(PROJECTS_PATH, "mcp_backups");

/** local time down to the millisecond: ids sort chronologically, which "latest" relies on */
const stamp = () => { const d = new Date(), p = (n: number, l = 2) => String(n).padStart(l, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`; };
const safeName = (s: string) => { if (!s || /[\\/]|^\.+$/.test(s)) throw new Error(`"${s}" is not a plain project folder name.`); return s; };
const list = (name: string) => { const d = path.join(BACKUPS_PATH, name); return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; };

/**
 * Copy a project of myprojects to mcp_backups. Returns the backup id.
 * ponytail: full copy every time and no pruning (projects are tens of MB); delete old folders by hand if they pile up.
 */
export function backupProject(project: string, note?: string): { id: string; dir: string } {
  const src = resolveProject(project);
  if (!src || !path.resolve(src).startsWith(MY_PROJECTS_PATH + path.sep)) throw new Error(`Only projects of myprojects can be backed up ("${project}" not found there).`);
  const name = path.basename(src);
  let id = stamp() + (note ? "_" + note.replace(/[^\w-]+/g, "-").slice(0, 30) : "");
  while (list(name).includes(id)) id += "_";   // two backups in the same second
  const dir = path.join(BACKUPS_PATH, name, id);
  fs.cpSync(src, dir, { recursive: true });
  return { id, dir };
}

export function backupTool(project: string, note?: string): string {
  const b = backupProject(project, note);
  return `Backed up "${project}" as ${b.id} (${b.dir}). Undo later changes with restore_project {project:"${project}", backup:"${b.id}"} (backup:"latest" for the newest).`;
}

/** No `backup` = list the backups of the project. Otherwise put that backup back (the current state is backed up first, so a restore can be undone too). */
export function restoreProject(project: string, backup?: string): string {
  const name = safeName(project), have = list(name);
  if (!backup) return have.length ? `Backups of "${name}" (oldest first):\n${have.map(b => "  " + b).join("\n")}\nrestore_project {project:"${name}", backup:"<id>" | "latest"}` : `No backups of "${name}" in ${BACKUPS_PATH}.`;
  const id = backup === "latest" ? have[have.length - 1] : safeName(backup);
  if (!id || !have.includes(id)) throw new Error(`Backup "${backup}" of "${name}" not found. Have: ${have.join(", ") || "none"}.`);
  const dest = path.join(MY_PROJECTS_PATH, name);
  let before = "";
  if (fs.existsSync(dest)) { before = ` The state before the restore is saved as ${backupProject(name, "before-restore").id}.`; fs.rmSync(dest, { recursive: true, force: true }); }
  fs.cpSync(path.join(BACKUPS_PATH, name, id), dest, { recursive: true });
  return `Restored "${name}" from ${id}.${before} Reapply it (apply_wallpaper / capture_wallpaper) to load the files from disk.`;
}
