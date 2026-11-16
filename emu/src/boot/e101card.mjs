// S-SDCARD for the E-PM2 (src/boot/e101.mjs S-SDCMD): an SD card at the SD driver's command seam, and the FAT16 image
// it holds. Pure: the image is a Uint8Array; host/boot.mjs builds one from a host folder and writes it back.
//
// The seam: the driver's command exchange 0x7e5ceabb(a0 = host context, a1 = command record) and its queue 0x7e5ce3e1.
// The record (D: 0x7e5ce3e1, 0x7e5ce767, 0x7e5cbf44, 0x7e5cc3d6):
//   +8 completion callback, +12 u16 host slot, +14 u16 type (3 a card command; 0, 4, 0x10, 0x11, 0x12 host set-up)
//   +36 command word: bits 0..5 the index, bits 6..7 = 01 an application command (natively the driver sends CMD55
//       itself), bits 8..10 the response form (3 none, 6 R2: 8 half-words, else 32 bits), bit 11 with data
//   +40 argument, +44..+59 the response (R2: bits 8..127 of the register, low word first)
//   +60 data buffer (a bus address; 0 no data), +64 block count, +68 block size, +73 u8 direction (0 read from the card)
//   +88 u16 status: 0 done, 0x1405 no response, 0x1404 an error
// the same command word as the later bodies' SD command layer, whose card is src/lab/sdcard.mjs (SDHC and SDXC only).
// This card is the one the E-PM2 runs (X: the firmware mounts, lists, formats and writes it): SD version 2, standard
// capacity (byte addresses in CMD17 / 18 / 24 / 25), one FAT16 partition behind an MBR (A-SDSC: the lab's choice; an
// SDHC card on the E-PM2 is not tried, ?).

const SEC = 512;
const le16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const le32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
const rd16 = (b, o) => b[o] | b[o + 1] << 8;
const rd32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const text = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const concat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// ---- a FAT16 image of a folder tree (8.3 names; sub-folders): tree = {entries: [{name, data} | {name, dir: tree}]},
// each folder's entries in the host's order (host/boot.mjs: by name). The files of a folder come first in its
// directory, then its sub-folders; the folders are laid out depth first. 64 MiB, 8 sectors a cluster, the partition at
// sector 63 (the lab's choice). Returns {img, files, info}
export function buildFat16(tree, { sizeMiB = 64, label = 'E101EMU' } = {}) {
  const total = sizeMiB * 2048, partStart = 63, partSecs = total - partStart, spc = 8, reserved = 1, nfats = 2, rootEnts = 512;
  const rootSecs = rootEnts * 32 / SEC;
  let fatSecs = 1;
  for (;;) { const clusters = Math.floor((partSecs - reserved - nfats * fatSecs - rootSecs) / spc); const need = Math.ceil((clusters + 2) * 2 / SEC); if (need <= fatSecs) break; fatSecs = need; }
  const dataStart = partStart + reserved + nfats * fatSecs + rootSecs, clusters = Math.floor((total - dataStart) / spc);
  const img = new Uint8Array(total * SEC), fat = new Uint8Array(fatSecs * SEC);
  le16(fat, 0, 0xFFF8); le16(fat, 2, 0xFFFF);
  let next = 2;
  const alloc = (data) => {                      // -> the first cluster (0 for an empty file)
    const n = Math.ceil(data.length / (spc * SEC)); if (!n) return 0;
    if (next + n > clusters + 2) throw new Error('FAT image full');
    const first = next;
    for (let i = 0; i < n; i++) le16(fat, 2 * (next + i), i === n - 1 ? 0xFFFF : next + i + 1);
    img.set(data, (dataStart + (first - 2) * spc) * SEC);
    next += n; return first;
  };
  const name83 = (n) => { const m = /^([^.]{1,8})(?:\.([^.]{0,3}))?$/.exec(n.toUpperCase()); if (!m) throw new Error(`not an 8.3 name: ${n}`); return latin1(m[1].padEnd(8) + (m[2] || '').padEnd(3)); };
  const DATE = ((2026 - 1980) << 9) | (11 << 5) | 14, TIME = 12 << 11;
  const entry = (nameBuf, attr, cluster, size) => { const e = new Uint8Array(32); e.set(nameBuf, 0); e[11] = attr; le16(e, 14, TIME); le16(e, 16, DATE); le16(e, 18, DATE); le16(e, 22, TIME); le16(e, 24, DATE); le16(e, 26, cluster); le32(e, 28, size); return e; };
  const files = [];
  const addDir = (node, isRoot, rel) => {         // -> {ents, pending}
    const ents = [], pending = [];
    if (isRoot) ents.push(entry(latin1(label.padEnd(11).slice(0, 11)), 0x08, 0, 0));
    for (const k of node ? node.entries : []) {
      if (k.dir) pending.push([k.name, k.dir]);
      else { ents.push(entry(name83(k.name), 0x20, alloc(k.data), k.data.length)); files.push(`${rel}/${k.name.toUpperCase()} ${k.data.length}`); }
    }
    return { ents, pending };
  };
  const layoutDir = (node, parentCluster, rel) => {
    const { ents, pending } = addDir(node, false, rel);
    const sub = [];
    const nEnts = 2 + ents.length + pending.length, bytes = Math.ceil(nEnts * 32 / (spc * SEC)) * spc * SEC;
    const my = alloc(new Uint8Array(bytes));
    for (const [n, d] of pending) sub.push(entry(name83(n), 0x10, layoutDir(d, my, `${rel}/${n.toUpperCase()}`), 0));
    const dot = entry(latin1('.          '), 0x10, my, 0), dotdot = entry(latin1('..         '), 0x10, parentCluster, 0);
    img.set(concat([dot, dotdot, ...ents, ...sub]), (dataStart + (my - 2) * spc) * SEC);
    return my;
  };
  const root = addDir(tree, true, '');
  const rootSub = root.pending.map(([n, d]) => entry(name83(n), 0x10, layoutDir(d, 0, `/${n.toUpperCase()}`), 0));
  const rootBuf = concat([...root.ents, ...rootSub]);
  if (rootBuf.length > rootEnts * 32) throw new Error('root directory full');
  // MBR
  img[446 + 4] = 0x06; le32(img, 446 + 8, partStart); le32(img, 446 + 12, partSecs); img[510] = 0x55; img[511] = 0xAA;
  // boot sector
  const bs = new Uint8Array(SEC);
  bs[0] = 0xEB; bs[1] = 0x3C; bs[2] = 0x90; bs.set(latin1('MSDOS5.0'), 3);
  le16(bs, 11, SEC); bs[13] = spc; le16(bs, 14, reserved); bs[16] = nfats; le16(bs, 17, rootEnts);
  if (partSecs < 65536) le16(bs, 19, partSecs); else le32(bs, 32, partSecs);
  bs[21] = 0xF8; le16(bs, 22, fatSecs); le16(bs, 24, 63); le16(bs, 26, 255); le32(bs, 28, partStart);
  bs[36] = 0x80; bs[38] = 0x29; le32(bs, 39, 0x1010E101); bs.set(latin1(label.padEnd(11).slice(0, 11)), 43); bs.set(latin1('FAT16   '), 54); bs[510] = 0x55; bs[511] = 0xAA;
  img.set(bs, partStart * SEC);
  for (let i = 0; i < nfats; i++) img.set(fat, (partStart + reserved + i * fatSecs) * SEC);
  img.set(rootBuf, (partStart + reserved + nfats * fatSecs) * SEC);
  return { img, files, info: { total, partStart, fatSecs, dataStart, spc, clusters, used: next - 2 } };
}

// ---- the files of such an image (or of one the firmware changed): [{path, size, cluster, data()}] (short names only)
export function listFat(img) {
  const p = rd32(img, 446 + 8), bs = img.subarray(p * SEC, p * SEC + SEC);
  const spc = bs[13], reserved = rd16(bs, 14), nf = bs[16], re = rd16(bs, 17), fs16 = rd16(bs, 22);
  const fatOff = (p + reserved) * SEC, rootOff = (p + reserved + nf * fs16) * SEC, dataOff = rootOff + re * 32, out = [];
  const chain = (c) => { const parts = []; for (let n = 0; c >= 2 && c < 0xFFF0 && n < 70000; n++) { parts.push(img.subarray(dataOff + (c - 2) * spc * SEC, dataOff + (c - 1) * spc * SEC)); c = rd16(img, fatOff + 2 * c); } return concat(parts); };
  const walk = (buf, rel) => {
    for (let o = 0; o + 32 <= buf.length; o += 32) {
      const e = buf.subarray(o, o + 32);
      if (e[0] === 0) break;
      if (e[0] === 0xE5 || (e[11] & 0x0F) === 0x0F || (e[11] & 0x08) || e[0] === 0x2E) continue;
      const n = text(e, 0, 8).trim(), x = text(e, 8, 11).trim(), name = x ? `${n}.${x}` : n, cl = rd16(e, 26), size = rd32(e, 28);
      if (e[11] & 0x10) walk(chain(cl), `${rel}/${name}`); else out.push({ path: `${rel}/${name}`, size, cluster: cl, data: () => chain(cl).subarray(0, size) });
    }
  };
  walk(img.subarray(rootOff, rootOff + re * 32), '');
  return out;
}

// ---- the card: lab.sdCmd(record) -> status serves S-SDCMD; lab.card = {img, log, reads, writes, unknown, dirty}
export function attachCard(e, img, { log = false } = {}) {
  const sectors = img.length / SEC, RCA = 0x1234;
  const card = e.card = { img, log: [], state: 'idle', blocklen: 512, reads: 0, writes: 0, unknown: new Map(), dirty: false };
  // CSD version 1: READ_BL_LEN 9, C_SIZE_MULT 7 (x 512), C_SIZE + 1 = sectors / 512
  const csd = new Uint8Array(16), setBits = (buf, hi, lo, v) => { for (let b = lo; b <= hi; b++, v = Math.floor(v / 2)) if (v & 1) buf[15 - (b >> 3)] |= 1 << (b & 7); };
  setBits(csd, 119, 112, 0x0E); setBits(csd, 111, 104, 0x00); setBits(csd, 103, 96, 0x32); setBits(csd, 95, 84, 0x5B5); setBits(csd, 83, 80, 9);
  setBits(csd, 79, 79, 1); setBits(csd, 73, 62, sectors / 512 - 1); setBits(csd, 49, 47, 7); setBits(csd, 46, 46, 1); setBits(csd, 45, 39, 0x7F); setBits(csd, 25, 22, 9); setBits(csd, 0, 0, 1);
  const cid = Uint8Array.from([0x03, 0x53, 0x44, 0x45, 0x31, 0x30, 0x31, 0x20, 0x10, 0x10, 0x10, 0xE1, 0x01, 0x01, 0x1B, 0x01]);
  const scr = Uint8Array.from([0x02, 0x25, 0x00, 0x00, 0, 0, 0, 0]);                 // SD spec 2.00, 1- and 4-bit bus
  const r2 = (c, reg) => { for (let k = 0; k < 15; k++) e.w8(c + 44 + k, reg[14 - k]); e.w8(c + 59, 0); };   // register bits 8..127, low byte first
  const cpu = (a) => (((a >>> 0) & 0x3FFFFFFF) | 0x40000000) >>> 0;
  const status = () => ((card.state === 'tran' ? 4 : card.state === 'stby' ? 3 : card.state === 'ident' ? 2 : card.state === 'ready' ? 1 : 0) << 9) | 0x100 | (card.app ? 0x20 : 0);
  const dataOut = (c, bytes) => { const buf = e.r32(c + 60), n = e.r32(c + 64) * e.r32(c + 68); if (buf) e.wr(cpu(buf), bytes.subarray(0, Math.min(n, bytes.length))); };
  e.pins.set(0xBE, 0);
  e.sdCmd = (c) => {
    const type = e.r16(c + 14);
    if (type !== 3) return 0;                                      // host set-up (clock, power, bus width): done
    const w = e.r32(c + 36), idx = w & 63, app = (w & 0xC0) === 0x40, arg = e.r32(c + 40) >>> 0;
    const buf = e.r32(c + 60), count = e.r32(c + 64), size = e.r32(c + 68), write = e.r8(c + 73) !== 0;
    const R1 = (v) => { e.w32(c + 44, v >>> 0); return 0; };
    if (log || card.log.length < 300) card.log.push(`${(e.m.devices.clock.t / 1e6).toFixed(1)} ${app ? 'A' : ''}CMD${idx} arg ${arg.toString(16)}${buf ? ` data ${count} x ${size} ${write ? 'write' : 'read'}` : ''}`);
    if (app) switch (idx) {
      case 41: card.state = 'ready'; return R1(0x80FF8000);        // OCR: power up done, standard capacity
      case 6: return R1(status());
      case 51: dataOut(c, scr); return R1(status());
      case 13: dataOut(c, new Uint8Array(64)); return R1(status());
      case 23: case 42: return R1(status());
      default: card.unknown.set('A' + idx, (card.unknown.get('A' + idx) || 0) + 1); return 0x1405;
    }
    switch (idx) {
      case 0: card.state = 'idle'; return 0;
      case 8: return R1(arg);
      case 55: return R1(status() | 0x20);
      case 2: card.state = 'ident'; r2(c, cid); return 0;
      case 3: card.state = 'stby'; return R1((RCA << 16) | 0x0500);
      case 9: r2(c, csd); return 0;
      case 10: r2(c, cid); return 0;
      case 7: card.state = (arg >>> 16) === RCA ? 'tran' : 'stby'; return R1(status());
      case 13: return R1(status());
      case 16: card.blocklen = arg; return R1(status());
      case 12: return R1(status());
      case 6: { const st = new Uint8Array(64); st[0] = 0x00; st[1] = 0x64; st[13] = 0x03; st[16] = (arg >>> 31) ? (arg & 15) : 0; dataOut(c, st); return R1(status()); }   // switch function: default speed only
      case 17: case 18: { const n = count * size, off = arg; if (off + n > img.length) return 0x1404; if (buf) e.wr(cpu(buf), img.subarray(off, off + n)); card.reads += count; return R1(status()); }
      case 24: case 25: { const n = count * size, off = arg; if (off + n > img.length) return 0x1404; if (buf) img.set(e.rd(cpu(buf), n), off); card.writes += count; card.dirty = true; return R1(status()); }
      case 32: case 33: case 38: return R1(status());
      default: card.unknown.set('C' + idx, (card.unknown.get('C' + idx) || 0) + 1); return 0x1405;
    }
  };
  return card;
}
