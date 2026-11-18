import * as fs from "fs";
import * as path from "path";
import { resolveProject } from "../resolve";
import { PropSpec, bindProperty } from "../sceneio";

export function updateProperties(
  project: string,
  setProps?: Record<string, unknown>,
  removeProps?: string[],
  setMeta?: Record<string, unknown>,
  setGeneral?: Record<string, unknown>,
  addProps?: PropSpec[],
): string {
  const projectDir = resolveProject(project);
  if (!projectDir) return `Project "${project}" not found.`;

  const projFile = path.join(projectDir, "project.json");
  if (!fs.existsSync(projFile)) return `No project.json in "${project}".`;

  const changes: string[] = [];
  // typed user properties first: bindProperty edits project.json itself
  for (const spec of addProps ?? []) {
    const b = bindProperty(projectDir, spec, spec.value ?? (spec.type === "bool" ? true : spec.type === "color" ? "1 1 1" : spec.type === "slider" ? 1 : ""));
    changes.push(`Property "${spec.property}" ready (default ${JSON.stringify(b.value)}); bind it with { "property": "${spec.property}" } in add_layer/update_layer/add_effect values.`);
  }

  const proj = JSON.parse(fs.readFileSync(projFile, "utf-8").replace(/^\uFEFF/, ""));
  if (setMeta) for (const [key, value] of Object.entries(setMeta)) { proj[key] = value; changes.push(`Set ${key} = ${JSON.stringify(value)}`); }
  proj.general = proj.general ?? {};
  // general.* other than properties, e.g. supportsaudioprocessing
  if (setGeneral) for (const [key, value] of Object.entries(setGeneral)) { if (key === "properties") continue; proj.general[key] = value; changes.push(`Set general.${key} = ${JSON.stringify(value)}`); }
  proj.general.properties = proj.general.properties ?? {};
  const props = proj.general.properties;
  if (setProps) for (const [key, value] of Object.entries(setProps)) { props[key] = value; changes.push(`Set property "${key}"`); }
  if (removeProps) for (const key of removeProps) if (key in props) { delete props[key]; changes.push(`Removed property "${key}"`); }

  if (!changes.length) return "No changes made.";
  fs.writeFileSync(projFile, JSON.stringify(proj, null, "\t"));
  return `Updated project.json for "${project}":\n${changes.map((c) => `  - ${c}`).join("\n")}`;
}
