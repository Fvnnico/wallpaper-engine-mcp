/*
 * Writer for a skinned puppet: MDLV0019 + MDLS0002, optional attachments (MDAT0001), no animations (MDLA).
 * Layout decoded from 69 real puppets; the same writer rebuilt 25 of them byte for byte and a generated file was
 * loaded, skinned and driven by SceneScript in Wallpaper Engine 2.8.42. Mesh space = layer px centred on the layer, y UP.
 */

export interface MdlVertex { x: number; y: number; u: number; v: number; bones: [number, number]; weights: [number, number] }
/** x, y = bind translation relative to the parent (the root: relative to the layer centre), layer px, y up; rotation is the identity.
 *  json = the bone's constraint / physics JSON (empty = plain bone). */
export interface MdlBone { name: string; parent: number; x: number; y: number; json?: string }
/** a named point that other layers can be parented to; x, y = offset from `bone` (layer px, y up) */
export interface MdlAttach { name: string; bone: number; x: number; y: number }

export function writeMdl(material: string, verts: MdlVertex[], indices: number[], bones: MdlBone[], attach: MdlAttach[] = []): Buffer {
  const parts: Buffer[] = [];
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const f32 = (...vs: number[]) => { for (const v of vs) { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b); } };
  const cstr = (s: string) => parts.push(Buffer.from(s + "\0", "utf8"));
  const zeros = (n: number) => parts.push(Buffer.alloc(n));
  const size = () => parts.reduce((n, b) => n + b.length, 0);

  cstr("MDLV0019"); u32(0x01800009); u32(1); u32(1); cstr(material); zeros(28); u32(0x0180000f); u32(verts.length * 80);
  for (const v of verts) { f32(v.x, v.y, 0, 0, 0, 1, 1, 0, 0, 1); u32(v.bones[0]); u32(v.bones[1]); u32(0); u32(0); f32(v.weights[0], v.weights[1], 0, 0, v.u, v.v); }
  const idx = Buffer.alloc(indices.length * 2); indices.forEach((i, k) => idx.writeUInt16LE(i, k * 2));
  u32(idx.length); parts.push(idx);

  cstr("MDLS0002"); const endAt = parts.length; u32(0); u32(bones.length);
  for (const b of bones) { cstr(b.name); u32(1); u32(b.parent >>> 0); u32(64); f32(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, b.x, b.y, 0, 1); cstr(b.json ?? ""); }
  // record block: one bounding box per bone (3f + 4x4); the engine takes the 0.5 default
  zeros(11); parts.push(Buffer.from([1]));
  for (let i = 0; i < bones.length; i++) f32(0.5, 0.5, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.5, 0.5, 1);
  parts.push(Buffer.from([1])); bones.forEach((_, i) => u32(i));
  parts[endAt].writeUInt32LE(size());
  if (attach.length) {
    // MDAT0001: [u32 end][u16 count] then per point [u16 bone][cstr name][4x4 matrix, translation in row 3]; as the last block `end` = file size - 1 (one zero byte closes the file)
    cstr("MDAT0001"); const at = parts.length; u32(0); u16(attach.length);
    for (const t of attach) { u16(t.bone); cstr(t.name); f32(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t.x, t.y, 0, 1); }
    parts[at].writeUInt32LE(size()); zeros(1);
  }
  return Buffer.concat(parts);
}
