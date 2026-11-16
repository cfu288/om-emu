// The boot lab's node host (src/boot/, bin/boot.mjs): its firmware from a .BIN, its card from a host folder, its kept
// state between runs and its screenshots, as files. Node-only (host/).
//   readBin(file)            the .BIN's OE blocks (src/fw/olyfw.mjs, every checksum checked), which the flash view
//                            holds, and its main code block; stock says whether that block is MODELS' pinned one (a
//                            patched build's is not). The OM block after them (the E-PM2's: load 0, 64 KiB) is the
//                            updater's, not the camera's flash (I), and is left out
//   folderTree(dir)          a host folder as src/boot/e101card.mjs buildFat16 takes it (entries by name, files and
//                            folders; anything else left out)
//   readState / writeState   the boot lab's kept state (src/boot/e101.mjs flashStateDoc), one JSON file
//   writePng(file, frame)    a composed frame (src/boot/e101screen.mjs compose) as a PNG: RGB, filter 0 rows, zlib's
//                            default level (host/server.mjs has the lab's encoders, but it imports the HLE lab, which
//                            does not load on a body without a port)
//   rtcSeconds(text)         a clock setting: Unix seconds, or a date and time read as UTC (2026-11-14T12:00:00)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { walkBytes, decodeBlock } from '../src/fw/olyfw.mjs';
import { MODELS } from '../src/fw/models.mjs';
import zlib from 'node:zlib';

const sha = (b) => createHash('sha256').update(b).digest('hex');

export function readBin(file, model = 'E101') {
  const u8 = new Uint8Array(fs.readFileSync(file)), { blocks: walked } = walkBytes(u8), blocks = [];
  for (const b of walked) {
    if (b.typ !== 'OE') continue;
    const all = u8.subarray(b.off, b.off + 64 + b.len), r = decodeBlock(all, b);
    if (!r.cksum_ok) throw new Error(`${file}: block at 0x${b.off.toString(16)} (flags 0x${b.flags.toString(16)}): checksum total 0x${r.cksum_tot.toString(16)}, not 0`);
    blocks.push({ block: b, head: all.subarray(0, 32), data: r.data, name: `${b.typ} 0x${b.flags.toString(16).padStart(4, '0')}` });
  }
  const main = blocks.find((x) => x.block.typ === 'OE' && x.block.flags === 0x0100);
  if (!main) throw new Error(`${file}: no main code block (OE, flags 0x0100) among ${blocks.length} blocks`);
  const m = MODELS[model];
  if (main.data.length !== m.rom_len) throw new Error(`${file}: the main block has ${main.data.length} bytes, ${model}'s ${m.rom_len} (another body's .BIN?)`);
  const digest = sha(main.data);
  return { rom: main.data, blocks, sha256: digest, stock: digest === m.rom_sha256 };
}

export function folderTree(dir) {
  const entries = [];
  for (const k of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, k.name);
    if (k.isDirectory()) entries.push({ name: k.name, dir: folderTree(p) });
    else if (k.isFile()) entries.push({ name: k.name, data: new Uint8Array(fs.readFileSync(p)) });
  }
  return { entries };
}

export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function writeState(file, doc) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export function png({ rgb, w, h }) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function writePng(file, frame) { fs.writeFileSync(file, png(frame)); }

export function rtcSeconds(text) {
  const v = /^\d+$/.test(text) ? Number(text) : Math.floor(Date.parse(text + 'Z') / 1000);
  if (!Number.isFinite(v)) throw new Error(`clock: ${JSON.stringify(text)} is neither Unix seconds nor a date and time (2026-11-14T12:00:00)`);
  return v;
}
