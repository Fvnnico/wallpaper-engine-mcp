// Starts the real server over stdio and talks to it like Cursor does: every tool must list with a usable schema,
// the resources must read, and a short scene workflow must run. Own throw-away Wallpaper Engine folder (WE_INSTALL_PATH), nothing of yours is touched.
// Run: npm run check (builds first)
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const we = fs.mkdtempSync(path.join(os.tmpdir(), "we-smoke-"));
fs.mkdirSync(path.join(we, "projects", "myprojects"), { recursive: true });

const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "index.js")], env: { ...process.env, WE_INSTALL_PATH: we } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.filter(c => c.type === "text").map(c => c.text).join("\n") };
};
const ok = async (name, args) => { const r = await call(name, args); assert.ok(!r.error, `${name}: ${r.text}`); return r.text; };

try {
  assert.strictEqual(client.getServerVersion().version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "server version = package.json");
  assert.match(client.getInstructions() ?? "", /we:\/\/scenescript-api/, "instructions point to the SceneScript typings");

  const { tools } = await client.listTools();
  assert.ok(tools.length >= 52, `tools listed: ${tools.length}`);
  for (const n of ["set_material", "optimize_textures", "create_effect", "create_particles", "create_video_wallpaper", "add_puppet"]) assert.ok(tools.some(t => t.name === n), `${n} is listed`);
  for (const t of tools) {
    assert.ok(t.description?.length > 20, `${t.name}: description`);
    assert.strictEqual(t.inputSchema?.type, "object", `${t.name}: input schema`);
  }

  const { resources } = await client.listResources();
  assert.ok(resources.length >= 4, "resources");
  // the SceneScript typings come from a real WE install; the throw-away one has none, so its resource is just a short notice
  for (const r of resources) assert.ok((await client.readResource({ uri: r.uri })).contents[0].text.length > (r.uri.endsWith("scenescript-api") ? 20 : 500), `${r.uri} reads`);

  // a bad call is a readable tool error, not a crash
  const bad = await call("get_scene", { project: "does_not_exist" });
  assert.ok(bad.error && /Error/.test(bad.text), "unknown project -> tool error");

  // short workflow through the protocol (zod parsing of the real arguments)
  await ok("create_scene_wallpaper", { name: "smoke_scene", background_color: "#203050" });
  assert.ok(fs.existsSync(path.join(we, "projects", "myprojects", "smoke_scene", "scene.json")));
  await ok("add_solid_layer", { project: "smoke_scene", name: "body", x: 960, y: 700, width: 500, height: 700, color: "#e08030" });
  await ok("add_solid_layer", { project: "smoke_scene", name: "head", x: 960, y: 260, width: 240, height: 240, color: "#f0d0b0" });
  await ok("add_motion_rig", { project: "smoke_scene", body: ["body"], head: ["head"], head_pivot: { x: 960, y: 400 } });
  assert.match(await ok("get_scene", { project: "smoke_scene" }), /rig head aim/);
  assert.match(await ok("validate_project", { project: "smoke_scene" }), /erformance/);
  // the tools with nested schemas, through the protocol: the arguments go through zod exactly as Cursor sends them
  assert.match(await ok("create_effect", { project: "smoke_scene", name: "desat", params: [{ key: "amount", default: 1, range: [0, 1] }], code: "albedo.rgb = mix(albedo.rgb, CAST3(dot(vec3(0.11, 0.59, 0.3), albedo.rgb)), u_amount);" }), /desat/);
  assert.match(await ok("add_effect", { project: "smoke_scene", layer: "body", effect: "desat", values: { amount: 0.5 } }), /desat/);
  fs.mkdirSync(path.join(we, "projects", "myprojects", "smoke_scene", "materials"), { recursive: true });
  fs.writeFileSync(path.join(we, "projects", "myprojects", "smoke_scene", "materials", "dot.tex"), "x");
  assert.match(await ok("create_particles", {
    project: "smoke_scene", name: "sparks", x: 960, y: 900, texture: "dot", control_points: { "1": { pointer: true } },
    operator: [{ name: "movement" }, { name: "controlpointattract", controlpoint: 1, scale: -500, threshold: 200 }],
    children: [{ type: "eventdeath", system: { emitter: [{ name: "sphererandom", rate: 0, instantaneous: 10 }] } }],
  }), /from scratch/);
  // a puppet through the protocol (nested bones array)
  const blob = path.join(we, "blob.png"); await sharp({ create: { width: 64, height: 32, channels: 4, background: "#e04040" } }).png().toFile(blob);
  await ok("add_layer", { project: "smoke_scene", image: blob, name: "blob", x: 300, y: 300 });
  assert.match(await ok("add_puppet", { project: "smoke_scene", layer: "blob", bones: [{ name: "a", x: 268, y: 300 }, { name: "b", x: 332, y: 300, parent: "a" }], physics: { mode: "rigid" }, attach: [{ name: "pt", x: 332, y: 300, bone: "b" }] }), /2 bone[^]*Bone physics \(rigid\)[^]*Attachments: "pt" on b/);
  assert.ok(fs.existsSync(path.join(we, "projects", "myprojects", "smoke_scene", "models", "blob_mcp_puppet.mdl")), "the puppet file is written");
  assert.match(await ok("optimize_textures", { project: "smoke_scene" }), /Nothing to compress/);
  // the throw-away install has no stock models, so validate does report errors: just none about what was created above
  assert.doesNotMatch(await ok("validate_project", { project: "smoke_scene" }), /ERROR.*(desat|sparks|particles\/|effects\/)/);
  await ok("backup_project", { project: "smoke_scene" });
  console.log(`smoke ok (${tools.length} tools, ${resources.length} resources)`);
} finally {
  await client.close();
  fs.rmSync(we, { recursive: true, force: true });
}
