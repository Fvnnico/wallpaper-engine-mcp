# Wallpaper Engine MCP

An [MCP](https://modelcontextprotocol.io) server that lets an AI chat (Cursor, Claude Desktop, ...) create, edit, preview and control
[Wallpaper Engine](https://www.wallpaperengine.io) wallpapers. It writes the same files the Wallpaper Engine editor writes, so every scene it makes
opens in the editor and can be edited by hand afterwards. Scene wallpapers (layers, effects, masks, particles, scripts, lights) are the main target;
web wallpapers are supported too.

Windows only (Wallpaper Engine's platform). Tested against Wallpaper Engine 2.8.

## Install

```
npm install
npm run build
```

Register it in your MCP client. Cursor (`%USERPROFILE%\.cursor\mcp.json`):

```json
{
  "mcpServers": {
    "wallpaper-engine": {
      "command": "node",
      "args": ["C:/path/to/wallpaper-engine-mcp/dist/index.js"],
      "env": { "WE_INSTALL_PATH": "C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine" }
    }
  }
}
```

`WE_INSTALL_PATH` is the Wallpaper Engine folder. When it is not set the server looks in the usual Steam locations (`src/config.ts`).
After rebuilding, reload the MCP server in your client.

## What it does

The server ships its own instructions and three resources the AI should read first: `we://scene-guide` (coordinates, workflow, recipes, limits),
`we://effects-cookbook` and `we://api-reference` (sources in `docs/`), plus `we://scenescript-api` (the official SceneScript typings from your install).

| Area | Tools |
| --- | --- |
| Projects | `list_wallpapers`, `get_wallpaper_info`, `create_scene_wallpaper`, `create_wallpaper` (web), `create_video_wallpaper` (mp4), `read_wallpaper_file`, `write_wallpaper_file`, `delete_wallpaper_file`, `delete_wallpaper`, `update_properties`, `backup_project`, `restore_project` |
| Layers | `get_scene`, `add_layer` (image, animated frames / sprite sheet, mp4 video), `update_layer`, `remove_layer`, `duplicate_layer`, `add_group`, `add_solid_layer`, `add_effect_layer`, `add_text`, `add_sound`, `import_image`, `scene_settings`, `modify_scene` |
| Effects and look | `list_effects`, `add_effect`, `update_effect`, `remove_effect`, `create_mask`, `create_effect` (your own GLSL effect), `set_material` (normal map, metallic / roughness, reflection), `optimize_textures` (DXT) |
| Motion | `animate_layer` (keyframes + events), `add_script` (wobble, cursor, lag, gain, scene, click, audio, event, media, emit, daytime, hover, toggle, launch), `add_motion_rig`, `add_puppet` (puppet warp: skeleton, mesh, bone scripts, bone physics, attachment points), `add_particles`, `create_particles` (from scratch), `list_particles`, `add_light` (with volumetrics) |
| Look at it | `preview_scene` (layout), `inspect_image`, `capture_wallpaper` (what Wallpaper Engine really renders, in a pop-out window: your desktop wallpaper is not touched), `validate_project` |
| Run it | `apply_wallpaper`, `control_wallpaper`, `list_monitors` |
| Learn | `find_examples`, `copy_example_layer` (search and clone from the Workshop wallpapers you have installed), `unpack_pkg`, `convert_texture` |

`list_effects`, `add_script {list:true}` and `list_particles` print what is available; every tool's description says how to use it.


## Development

```
npm run check    # build + test/selfcheck.js (unit checks of the maths and formats) + test/smoke.mjs (starts the server over stdio, lists every tool, runs a short workflow)
```
