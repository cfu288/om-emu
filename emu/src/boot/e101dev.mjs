// The E-PM2's (E101) device models in the boot lab (src/boot/bootlab.mjs block): the register-level stand-ins of the
// blocks its firmware's start, menus and card use (docs/e101-boot-spec.md section 4). A model is {read(a, size) ->
// value | undefined, write(a, value, size) -> true when handled}; undefined / false is the boot lab's plain storage
// (H-PLAINREG). Addresses are the E-PM2 v1.6 build's (run-time base 0x7e421020); tags as in docs/README.md.
import { h8 } from './bootlab.mjs';

// ---- 0x98e00000 the system controller (om-emu's SCPU interface model is at this address on the E143 board; the
// E-PM2's is another device: the boot lab takes the page over)
//   +0xa4 command word: the firmware writes 0x20041001 and waits until it reads 0 (0x7e425f44): 0, done at once (S-SYSCMD)
//   +0x00 bit 1 set: the always-on domain kept its state (not a battery insertion). +0x48 wake factors, write 1 to
//   clear: bit 1 = factor 2 (0x7e45d2c3), which the table 0x7e73522c maps to event 0, the power lever (I). With +0x48
//   0 and +0x00 bit 1 clear the firmware takes factor 0, a battery insertion, and runs the card's firmware-update
//   check instead of the normal start (X: "[usr]firmup")
//   +0x58 + 4k (k 0..4): bit 31 is port k's input level (0x7e45d444 packs them into bits 0..4). UI_IN's group 1 key
//   table 0x7e735254 names them: port 0 key 0x0c (the ON/OFF button: wake factor 1 maps to event 12, which the quick
//   start requires, "UiONFact"), port 1 key 0, port 2 key 0x1506 (card presence, 0x7e5cc9de), port 3 key 0x400 (the
//   quick start tests it at 0x7e5026d0), port 4 key 0x121c (D). lab.ports holds the levels, bit k port k
//   +0x50: a pending bit per port whose level changed (write 1 to clear); IRQ 120 while any is set (ISR 0x7e45d5c7)
//   S-RTC (with opts.rtc only): +0x98 a seconds counter in Unix time (read through the SRAM routine 0x47001220, written
//   by 0x7e45d6cd; the driver's own conversion 0x7e508a6f, D), +0x9c bits 5..14 the milliseconds (0x47001229), +0x00
//   bits 2..7 the "clock set" marker 42 (0x7e45d756, 0x7e45d73f). opts.rtc (Unix seconds) sets the marker and the
//   counter at power-on; the counter then follows lab time. Without it the counter is plain storage: 0, "clock not
//   set" (the date prompt; the rows that need the clock are grey, X)
export function systemController(lab, { rtc = null, wakeFactor = 0x1 } = {}) {
  const intc = lab.m.devices.intc, sys = { wake: wakeFactor, pend: 0 };
  let clk = null;
  if (rtc !== null) { clk = lab.rtc = { base: rtc >>> 0, t0: 0 }; lab.store.set(0x98E00000, 42 << 2); }
  lab.setPorts = (levels) => { sys.pend |= (lab.ports ^ levels) & 0x1f; lab.ports = levels; intc.setLine(120, sys.pend !== 0); };
  return {
    read(a) {
      if (a === 0x98E000A4) return 0;
      if (a === 0x98E00000) return (lab.store.get(0x98E00000) ?? 0) | 0x2;
      if (clk && a === 0x98E00098) return (clk.base + Math.floor((lab.m.devices.clock.t - clk.t0) / 1e9)) >>> 0;
      if (clk && a === 0x98E0009C) return ((Math.floor(lab.m.devices.clock.t / 1e6) % 1000) << 5) >>> 0;
      if (a === 0x98E00048) return sys.wake;
      if (a === 0x98E00050) return sys.pend;
      if (a >= 0x98E00058 && a <= 0x98E00068) return (((lab.ports >>> ((a - 0x98E00058) >> 2)) & 1) << 31) >>> 0;
      return undefined;
    },
    write(a, v) {
      if (a === 0x98E00048) { sys.wake &= ~v; return true; }
      if (clk && a === 0x98E00098) { clk.base = v >>> 0; clk.t0 = lab.m.devices.clock.t; return true; }
      if (a === 0x98E00050) { sys.pend &= ~v; intc.setLine(120, sys.pend !== 0); return true; }
      return false;
    },
  };
}

// ---- 0x98c00000 the ADC (per_adc 0x7e45ab01..): +0x04 start / busy (bit 0 reads 0: a conversion is done at once),
// three completion groups {enable, status}: +0x10 / +0x14 (polled), +0x18 / +0x1c (IRQ mode, ISR 0x7e45b49d), +0x30 /
// +0x34 (started by +0x28); a status is set by its start and cleared by writing 1; IRQ 117 while any enabled status is
// set (D). Results +0x3c.. one word per input (0x7e45b33c): lab.adc[k] (S-ADC: 0x200 for every input, I; input 3 is
// the key ladder, UI_IN group 6, thresholds 0x22..0x2c2: 0x3ff is no key, D)
export function adc(lab) {
  const intc = lab.m.devices.intc, st = { en: [0, 0, 0], st: [0, 0, 0] };
  lab.adc = new Array(16).fill(0x200);
  lab.adc[3] = 0x3FF;
  intc.drive(117);
  const line = () => intc.setLine(117, st.en.some((en, i) => (en & st.st[i] & 1) !== 0));
  return {
    read(a) {
      const o = a - 0x98C00000;
      if (o === 0x04 || o === 0x28) return 0;
      if (o === 0x14) return st.st[0]; if (o === 0x1C) return st.st[1]; if (o === 0x34) return st.st[2];
      if (o >= 0x3C && o < 0x7C) return lab.adc[(o - 0x3C) >> 2];
      return undefined;
    },
    write(a, v) {
      const o = a - 0x98C00000;
      if (o === 0x04 && (v & 1)) { st.st[0] = 1; st.st[1] = 1; line(); return true; }
      if (o === 0x28 && (v & 1)) { st.st[2] = 1; line(); return true; }
      if (o === 0x10) { st.en[0] = v; line(); return false; }
      if (o === 0x18) { st.en[1] = v; line(); return false; }
      if (o === 0x30) { st.en[2] = v; line(); return false; }
      if (o === 0x14) { st.st[0] &= ~v; line(); return true; }
      if (o === 0x1C) { st.st[1] &= ~v; line(); return true; }
      if (o === 0x34) { st.st[2] &= ~v; line(); return true; }
      return false;
    },
  };
}

// ---- 0x99000000 the SD host (a TMIO-like core at +0x2000, as on the E144 and E118 boards, src/fw/board.mjs sd):
// +0x203c SD_INFO2 reads bit 13 set, the bus-idle flag the driver polls (0x7e5cbe99, D); the card's commands are served
// at the driver's command seam (S-SDCMD, src/boot/e101.mjs), not at the host's registers
export function sdHost(lab) {
  return {
    read(a) { if (a === 0x9900203C) return (lab.store.get(0x9900203C) ?? 0) | 0x2000; return undefined; },
    write() { return false; },
  };
}

// ---- 0x9a900000 the display controller: INTEN +0x0c, INTST +0x14 (write 1 to clear), as om-emu's kind-3 VSC (D: the
// driver 0x7e6b75c2..). Bit 0 frame and bit 4 line compare (the driver arms it at 0x7e6b77d6 and waits for it): both
// set every 16.683 ms of lab time (A-FRAME: 59.94 Hz, the TFT's period as the E118 family's frame_period_us; the
// E-PM2's is not read, I); IRQ 14 while INTST & INTEN. The rest of the block is plain storage, which
// src/boot/e101screen.mjs composes from. The 8-bit plane's palette has two banks, +0x400 and +0x600 (128 entries
// each), which the firmware loads in turn (0x7e6b7b55, D); the composer uses the bank written last (I: the select
// register is not identified, a candidate +0x30 bit 4)
export function displayController(lab) {
  const intc = lab.m.devices.intc, vsc = lab.vsc = { inten: 0, intst: 0, next: 16683000, period: 16683000, frames: 0, palBank: 0 };
  intc.drive(14); intc.drive(15);
  const line = () => intc.setLine(14, (vsc.inten & vsc.intst) !== 0);
  lab.m.devices.clock.add({ next: () => vsc.next, fire: (at) => { vsc.next = at + vsc.period; vsc.frames++; vsc.intst |= 0x11; line(); if (lab.onFrame) lab.onFrame(vsc.frames); } });
  return {
    read(a) { if (a === 0x9A90000C) return vsc.inten; if (a === 0x9A900014) return vsc.intst; return undefined; },
    write(a, v) {
      if (a === 0x9A90000C) { vsc.inten = v >>> 0; line(); return true; }
      if (a === 0x9A900014) { vsc.intst &= ~v; line(); return true; }
      if (a >= 0x9A900400 && a < 0x9A900800) vsc.palBank = a < 0x9A900600 ? 0x400 : 0x600;
      return false;
    },
  };
}

// ---- 0x9a100000 GIO
//   +0xf4..+0x100 deferred-call triggers (the posts 0x7e45f14d.. write 1, the handlers 0x7e45f242.. write 0): bit 0 of
//   word k is IRQ 23 + k's level (the same unit as om-emu's dpc on later bodies, src/dev/dpc.mjs; D)
//   +0x10 + 12k (k 0..14): one-shot timers {start, count, ..} (the tables 0x7e4c6a40 / 0x7e4c6af4; the soft-timer API
//   0x7e4650a2 runs on them). Timers 0..9 share IRQ 17 with the status +0xc4 (bit k, write 1 to clear) and the enable
//   +0xdc; timers 10..14 have IRQ 18..22 with the status +0xc8.. and the enable +0xe0.. (bit 0) (D). S-GIOTIMER: a
//   timer's time is the microseconds its set-up 0x7e462465(d0 = k, a0 -> {us, ..}) was given (the count register holds
//   clock counts scaled from SYSCLK registers the boot lab does not model, X)
//   +0x110 / +0x108 / +0x104: the bit-search unit: a value written to +0x110 is answered at +0x108 with the index of
//   its lowest set bit and at +0x104 with the index of its highest set bit, 32 when none is set (0x7e45d9c8 /
//   0x7e45d9f1; the hardware-timer allocator 0x7e462557 gives every soft timer a one-shot timer with it; I)
export function gio(lab) {
  const intc = lab.m.devices.intc;
  const gt = lab.gioTimers = { us: new Array(15).fill(1000), at: new Array(15).fill(Infinity), st: [0, 0, 0, 0, 0, 0], en: [0, 0, 0, 0, 0, 0] };
  for (let g = 0; g < 6; g++) intc.drive(17 + g);
  const lines = () => { for (let g = 0; g < 6; g++) intc.setLine(17 + g, (gt.st[g] & gt.en[g]) !== 0); };
  lab.hook(0x7E462465, 'S-GIOTIMER', () => { const k = lab.m.getRegs()[0] & 0xffff; if (k < 15) gt.us[k] = lab.r32(lab.m.getRegs()[4] >>> 0); });
  lab.m.devices.clock.add({
    next: () => Math.min(...gt.at),
    fire: (at) => { for (let k = 0; k < 15; k++) if (gt.at[k] === at) { gt.at[k] = Infinity; if (k < 10) gt.st[0] |= 1 << k; else gt.st[k - 9] |= 1; } lines(); },
  });
  for (let k = 0; k < 4; k++) intc.drive(23 + k);
  return {
    read(a) {
      const o = a - 0x9A100000;
      if (o >= 0xC4 && o <= 0xD8) return gt.st[(o - 0xC4) >> 2];
      if (o >= 0xDC && o <= 0xF0) return gt.en[(o - 0xDC) >> 2];
      if (o === 0x108) { const v = lab.store.get(0x9A100110) ?? 0; return v ? 31 - Math.clz32(v & -v) : 32; }
      if (o === 0x104) { const v = lab.store.get(0x9A100110) ?? 0; return v ? 31 - Math.clz32(v) : 32; }
      return undefined;
    },
    write(a, v) {
      const o = a - 0x9A100000;
      if (o >= 0x10 && o < 0xC4 && (o - 0x10) % 12 === 0) {
        const k = (o - 0x10) / 12, clock = lab.m.devices.clock;
        gt.at[k] = (v & 1) ? clock.t + Math.max(1, gt.us[k]) * 1000 : Infinity;
        return false;
      }
      if (o >= 0xC4 && o <= 0xD8) { gt.st[(o - 0xC4) >> 2] &= ~v; lines(); return true; }
      if (o >= 0xDC && o <= 0xF0) { gt.en[(o - 0xDC) >> 2] = v >>> 0; lines(); return true; }
      if (a >= 0x9A1000F4 && a <= 0x9A100100) { intc.setLine(23 + ((a - 0x9A1000F4) >> 2), (v & 1) !== 0); return false; }
      return false;
    },
  };
}

// ---- 0x9aa00000 the OSD draw engine (the command family of om-emu's src/dev/engine.mjs, another register use).
// Registers (the driver 0x7eccd276..0x7ecce2xx, D): +0x04 status (bit 0 done, bit 1 error; write 1 to clear), +0x08
// interrupt enable, IRQ 111 while status & enable; +0x18 / +0x1c the command list's address (the CPU's uncached
// alias), +0x20 = 1 list mode, +0x38 / +0x3c the command count, +0x24 start (1 the list, 2 the FIFO written through
// +0x28), +0x2c = 1 FIFO reset. S-OSDENGINE: the commands run at the start write and complete at once (A-OSDTIME).
// Commands (the builders read, D unless tagged): 0x10 fill, 0x20 copy, 0x30 run-length bitmap, 0x40 / 0x41 colour
// table, 0xff end. A surface is addressed in bits (byte address x 8 + bit offset) with depth d = log2(bits per pixel)
// (2: 4 bpp, 3: 8 bpp); of a 4-bpp byte the low nibble is the left pixel (I, checked on rendered text, X).
export function osdEngine(lab) {
  const intc = lab.m.devices.intc;
  intc.drive(111);
  const o = lab.osd = { st: 0, en: 0, fifo: [], runs: 0, cmds: 0, bitmaps: 0, log: [], unknown: new Map(), lut: new Uint8Array(256), trace: null };
  const line = () => intc.setLine(111, (o.st & o.en & 3) !== 0);
  const cpu = (a) => (((a >>> 0) & 0x3FFFFFFF) | 0x40000000) >>> 0;     // an engine bus address or CPU alias -> the cached CPU address
  o.cpu = cpu;
  const len = (w0) => { switch (w0 & 0xff) { case 0x10: return 4; case 0x20: return 5; case 0x30: return 4 + ((w0 & 0x6000) ? 1 : 0) + ((w0 & 0x1000) ? 4 : 0); case 0x40: case 0x41: return 2; case 0x60: return 5; case 0xff: return 1; default: return 0; } };
  const rdPix = (bits, d) => { const a = cpu(bits / 8); if (d === 3) return lab.r8(a); const b = lab.r8(a); return (bits & 4) ? b >> 4 : b & 15; };
  const wrPix = (bits, d, v) => { const a = cpu(bits / 8); if (d === 3) { lab.w8(a, v); return; } const b = lab.r8(a); lab.w8(a, (bits & 4) ? (b & 0x0f) | ((v & 15) << 4) : (b & 0xf0) | (v & 15)); };
  const hi = (w0) => (w0 & 0x60000000) >>> 0;
  const dims = (w) => ({ h: (w & 0x7ff) + 1, wd: ((w >>> 11) & 0x7ff) + 1, stride: (w >>> 22) * 64 });
  const bad = (msg, w) => { const k = msg + ' ' + h8(w[0]); if (!o.unknown.has(k)) o.log.push(`${msg}: ${w.map((x) => h8(x)).join(' ')}`); o.unknown.set(k, (o.unknown.get(k) || 0) + 1); };
  // 0x10 fill: w0 = opcode | depth << 8 | address bits 29..30; w1 colour; w2 = (address & 0x1fffffff) << 3 | bit;
  //   w3 = (lines - 1) | (width - 1) << 11 | (stride bytes / 64) << 22 (the builder 0x7eccd77a)
  const fill = (w) => {
    const d = (w[0] >>> 8) & 7, { h, wd, stride } = dims(w[3]), base = (hi(w[0]) + (w[2] >>> 3)) * 8 + (w[2] & 7), bpp = 1 << d;
    if (d !== 2 && d !== 3) return bad('fill depth', w);
    for (let y = 0; y < h; y++) {
      const row = base + y * stride * 8;
      if (d === 3) { lab.wr(cpu(row / 8), new Uint8Array(wd).fill(w[1] & 255)); continue; }
      if (!(row & 7) && !(wd & 1)) { lab.wr(cpu(row / 8), new Uint8Array(wd / 2).fill((w[1] & 15) * 0x11)); continue; }
      for (let x = 0; x < wd; x++) wrPix(row + x * bpp, d, w[1]);
    }
  };
  // 0x20 copy: w0 = opcode | depth << 8 | the source's address bits 29..30 at bits 26..27 | the destination's at 29..30;
  //   w1 = source << 3; w2 size and source stride (as fill's w3); w3 = destination << 3; w4 = destination stride << 22
  const copy = (w) => {
    const d = (w[0] >>> 8) & 7, { h, wd, stride } = dims(w[2]), dstride = (w[4] >>> 22) * 64, bpp = 1 << d;
    const src = ((((w[0] >>> 26) & 3) << 29 >>> 0) + (w[1] >>> 3)) * 8 + (w[1] & 7), dst = (hi(w[0]) + (w[3] >>> 3)) * 8 + (w[3] & 7);
    if (d !== 2 && d !== 3) return bad('copy depth', w);
    const nbytes = d === 3 ? wd : (wd + 1) >> 1, whole = !(src & 7) && !(dst & 7) && (d === 3 || !(wd & 1));
    for (let y = 0; y < h; y++) {
      const s = src + y * stride * 8, t = dst + y * dstride * 8;
      if (whole) { lab.wr(cpu(t / 8), lab.rd(cpu(s / 8), nbytes).slice()); continue; }
      const row = []; for (let x = 0; x < wd; x++) row.push(rdPix(s + x * bpp, d));
      for (let x = 0; x < wd; x++) wrPix(t + x * bpp, d, row[x]);
    }
  };
  // 0x40 colour table: w1 = address >> 6; 256 bytes
  const lut = (w) => { o.lut = lab.rd(cpu((w[1] << 6) >>> 0), 256).slice(); o.lutAddr = cpu((w[1] << 6) >>> 0); };
  // 0x30 run-length bitmap: w0 = opcode | depth << 8 | 0x800 through a colour table | 0x1000 the table is the 4 words
  //   after w3 (16 entries) | 0x2000 / 0x4000 scaled (one more word; A-OSDSCALE: drawn unscaled); w1 source (a CPU
  //   address); w2 = destination << 3 | bit; w3 = stride bytes / 64 (0x0e: 896, the 8-bit plane's; 7: 448, a 4-bit
  //   plane's). The source: a 4-byte header {lines - 1 : 12, width - 1 : 12, format : 8}, then tokens (the formats of
  //   om-emu's engine model for later bodies: 1, 2, 3, 9, 0x0a, 0x0b). A-OSDCLEAR: a pixel whose token colour is 0, or
  //   whose table value is 0, is not written (transparent; I)
  const field64 = (lo, hiw, start, n) => (start >= 32 ? hiw >>> (start - 32) : start + n <= 32 ? lo >>> start : (lo >>> start) | (hiw << (32 - start)));
  const bitmap = (w) => {
    const d = (w[0] >>> 8) & 7, src = cpu(w[1]);
    if (w[0] & 0x6000) bad('bitmap scaled (drawn unscaled)', w);
    if (d !== 2 && d !== 3) return bad('bitmap depth', w);
    const hdr = lab.rd(src, 4), lines = (hdr[0] | (hdr[1] & 0xF) << 8) + 1, width = (hdr[1] >> 4 | hdr[2] << 4) + 1, fmt = hdr[3];
    let bits, runbits, perWord;
    switch (fmt) {
      case 0x02: case 0x0A: bits = 8; runbits = 4; perWord = 0; break;
      case 0x09: bits = 8; runbits = 6; perWord = 0; break;
      case 0x01: bits = 4; runbits = 2; perWord = 16; break;
      case 0x03: bits = 10; runbits = 2; perWord = 6; break;
      case 0x0B: bits = 12; runbits = 4; perWord = 5; break;
      default: return bad('bitmap format ' + fmt, w);
    }
    const useLut = (w[0] & 0x800) !== 0, inline = (w[0] & 0x1000) !== 0, map = new Uint8Array(256);
    const ext = 4 + ((w[0] & 0x6000) ? 1 : 0);
    if (inline) for (let i = 0; i < 16; i++) map[i] = w[ext + (i >> 2)] >>> (8 * (i % 4));
    else if (useLut) map.set(o.lut);
    else for (let i = 0; i < 256; i++) map[i] = i;
    const stride = (w[3] & 0x7ff) << 6, dst = (hi(w[0]) + (w[2] >>> 3)) * 8 + (w[2] & 7), bpp = 1 << d;
    const total = width * lines, need = perWord ? Math.ceil(total / perWord) * 8 : total;
    const data = lab.rd(src + 4, Math.min(need + 8, 0x40000)), dv = new DataView(data.buffer, data.byteOffset, data.length);
    const px = new Uint8Array(total), mask = 2 ** bits - 1, runmask = (1 << runbits) - 1;
    let count = 0, pos = 0;
    while (count < total && pos + (perWord ? 8 : 1) <= data.length) {
      if (perWord) {
        const lo = dv.getUint32(pos, true), hw = dv.getUint32(pos + 4, true);
        for (let k = 0; k < perWord && count < total; k++) { const t = field64(lo, hw, bits * k, bits) & mask, run = (t & runmask) + 1; px.fill(t >>> runbits, count, Math.min(total, count + run)); count += run; }
        pos += 8;
      } else { const t = data[pos++], run = (t & runmask) + 1; px.fill(t >>> runbits, count, Math.min(total, count + run)); count += run; }
    }
    for (let y = 0; y < lines; y++) for (let x = 0; x < width; x++) {
      const idx = px[y * width + x], v = map[idx];
      if (idx === 0 || v === 0) continue;
      wrPix(dst + (y * stride * 8) + x * bpp, d, v);
    }
    o.bitmaps++;
  };
  o.exec = (w) => {
    o.cmds++;
    if (o.trace) o.trace(w);
    const op = w[0] & 0xff;
    o.unknown.set(op, (o.unknown.get(op) || 0) + 1);
    try {
      if (op === 0x10) fill(w); else if (op === 0x20) copy(w); else if (op === 0x30) bitmap(w); else if (op === 0x40) lut(w); else bad('opcode not modelled', w);
    } catch (err) { bad('error ' + err.message, w); }
  };
  const run = (words) => {
    o.runs++;
    for (let i = 0; i < words.length;) {
      const n = len(words[i]);
      if (!n) { o.log.push(`unknown opcode ${h8(words[i])} at word ${i}`); break; }
      if ((words[i] & 0xff) === 0xff) break;
      o.exec(words.slice(i, i + n)); i += n;
    }
  };
  return {
    read(a) { if (a === 0x9AA00004) return o.st; return undefined; },
    write(a, v) {
      const off = a - 0x9AA00000;
      if (off === 0x04) { o.st &= ~v; line(); return true; }
      if (off === 0x08) { o.en = v >>> 0; line(); return false; }
      if (off === 0x28) { o.fifo.push(v >>> 0); return false; }
      if (off === 0x2C) { if (v & 1) o.fifo = []; return false; }
      if (off === 0x24 && v) {
        if (v === 1) {
          // the list (at +0x18) ends with a command 0xff: read command by command, at most 0x3ff0 words
          const base = cpu(lab.store.get(0x9AA00018) ?? 0), words = [];
          for (let i = 0; i < 0x4000; i++) words.push(lab.r32(base + 4 * i));
          const out = []; let p = 0;
          for (;;) { const n = len(words[p]); if (!n) { o.log.push(`list: unknown ${h8(words[p])}`); break; } for (let k = 0; k < n; k++) out.push(words[p + k]); if ((words[p] & 0xff) === 0xff) break; p += n; if (p > 0x3ff0) break; }
          run(out);
        } else { run(o.fifo); o.fifo = []; }
        o.st |= 1; line();
        return false;
      }
      return false;
    },
  };
}
