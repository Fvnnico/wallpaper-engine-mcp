import * as fs from "fs";
import * as path from "path";

// Wallpaper Engine .pkg container:
//   int32 len + "PKGVxxxx", int32 count, count x { int32 len + name, int32 offset, int32 length }, then data.
// Entry offsets are relative to the end of the table.

export interface PkgEntry { name: string; offset: number; length: number }

export function readPkgIndex(buf: Buffer): { version: string; entries: PkgEntry[]; dataStart: number } {
  let o = 0;
  const str = () => { const n = buf.readInt32LE(o); o += 4; const s = buf.toString("utf8", o, o + n); o += n; return s; };
  const version = str();
  if (!version.startsWith("PKGV")) throw new Error(`Not a .pkg file (header "${version.slice(0, 12)}")`);
  const count = buf.readInt32LE(o); o += 4;
  const entries: PkgEntry[] = [];
  for (let i = 0; i < count; i++) {
    const name = str();
    const offset = buf.readInt32LE(o); o += 4;
    const length = buf.readInt32LE(o); o += 4;
    entries.push({ name, offset, length });
  }
  return { version, entries, dataStart: o };
}

/** Unpack a .pkg into outDir. `only` filters entry names (regex on the path). Returns the written entries. */
export function unpackPkg(pkgFile: string, outDir: string, only?: RegExp): { version: string; total: number; written: PkgEntry[] } {
  const buf = fs.readFileSync(pkgFile);
  const { version, entries, dataStart } = readPkgIndex(buf);
  const written: PkgEntry[] = [];
  for (const e of entries) {
    if (only && !only.test(e.name)) continue;
    const dest = path.resolve(outDir, e.name);
    if (!dest.startsWith(path.resolve(outDir) + path.sep)) continue; // never write outside outDir
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf.subarray(dataStart + e.offset, dataStart + e.offset + e.length));
    written.push(e);
  }
  return { version, total: entries.length, written };
}

/** Read single files out of a .pkg without loading it whole (Workshop packages can be hundreds of MB). */
export function openPkg(file: string): { entries: Map<string, PkgEntry>; read(name: string): Buffer | undefined } {
  const fd = fs.openSync(file, "r");
  try {
    // the index sits at the start: read a growing prefix until it parses
    let size = 1 << 16, idx: ReturnType<typeof readPkgIndex>;
    for (;;) {
      const buf = Buffer.alloc(size), n = fs.readSync(fd, buf, 0, size, 0);
      try { idx = readPkgIndex(buf.subarray(0, n)); break; } catch (e) { if (n < size || size >= 1 << 28) throw e; size *= 4; }
    }
    const entries = new Map(idx.entries.map(e => [e.name, e] as [string, PkgEntry]));
    return {
      entries,
      read(name) {
        const e = entries.get(name);
        if (!e) return undefined;
        const out = Buffer.alloc(e.length), f = fs.openSync(file, "r");
        try { fs.readSync(f, out, 0, e.length, idx.dataStart + e.offset); } finally { fs.closeSync(f); }
        return out;
      },
    };
  } finally { fs.closeSync(fd); }
}
