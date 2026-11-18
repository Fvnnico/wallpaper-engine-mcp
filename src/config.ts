import * as fs from "fs";
import * as path from "path";

const DEFAULT_PATHS = [
  "C:\\SteamLibrary\\steamapps\\common\\wallpaper_engine",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine",
  "D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine",
];

function findInstallPath(): string {
  const envPath = process.env.WE_INSTALL_PATH;
  if (envPath && fs.existsSync(envPath)) return path.resolve(envPath);

  for (const p of DEFAULT_PATHS) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    "Wallpaper Engine installation not found. Set WE_INSTALL_PATH env var."
  );
}

export const WE_PATH = findInstallPath();
export const WE_EXE = path.join(WE_PATH, "wallpaper32.exe");
export const PROJECTS_PATH = path.join(WE_PATH, "projects");
export const MY_PROJECTS_PATH = path.join(PROJECTS_PATH, "myprojects");
export const DEFAULT_PROJECTS_PATH = path.join(PROJECTS_PATH, "defaultprojects");

function findWorkshopPath(): string | null {
  // Workshop is a sibling of the steamapps/common dir
  const steamapps = path.resolve(WE_PATH, "..", "..");
  const workshop = path.join(steamapps, "workshop", "content", "431960");
  return fs.existsSync(workshop) ? workshop : null;
}

export const WORKSHOP_PATH = findWorkshopPath();
