import * as fs from "fs";
import * as path from "path";
import { resolveProject } from "../resolve";

export function importImage(
  project: string,
  sourcePath: string,
  destPath?: string
): string {
  const projectDir = resolveProject(project);
  if (!projectDir) return `Project "${project}" not found.`;

  if (!path.isAbsolute(sourcePath))
    return `Source path must be absolute. Got: "${sourcePath}"`;
  if (!fs.existsSync(sourcePath))
    return `Source file not found: "${sourcePath}"`;

  const fileName = destPath || path.basename(sourcePath);
  const dest = path.join(projectDir, fileName);
  if (!dest.startsWith(projectDir)) return "Invalid destination path.";

  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  fs.copyFileSync(sourcePath, dest);
  const size = fs.statSync(dest).size;
  const relPath = path.relative(projectDir, dest).replace(/\\/g, "/");

  return [
    `Imported "${path.basename(sourcePath)}" into project "${project}".`,
    `  Destination: ${relPath}`,
    `  Size: ${(size / 1024).toFixed(1)} KB`,
    "",
    "Usage in HTML/CSS:",
    `  <img src="${relPath}">`,
    `  background-image: url('${relPath}');`,
  ].join("\n");
}
