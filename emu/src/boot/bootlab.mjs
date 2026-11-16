// The boot lab: a body's firmware run from its reset vector on om-emu's machine (src/machine.mjs: the CPU, memory,
// interrupt controller, timer and second core), with no HLE lab above it (docs/e101-boot-spec.md). Where the HLE labs
// (src/lab/hle.mjs) start from a made-up state after the boot and translate E143's addresses to the body's, the boot
// lab lets the body's own reset code, loaders, kernels and tasks run and stands in only at named seams: pc hooks at the
// body's own addresses (stand-ins S-*, harness steps H-*) and the device blocks of its MMIO the body module declares.
// A body module (src/boot/e101.mjs) builds one; it holds every body fact. Pure: the firmware, a saved state and a
// card image are passed in, files are the host's (host/boot.mjs).
//
// What it adds to the machine:
//   - the flash view (src/boot/flash.mjs), which the body's flash stand-ins read and write;
//   - RAM regions the body names that the board's map lacks (ram option);
//   - the MMIO blocks of 0x80000000..0x9fffffff the machine's devices do not hold: each one is declared by the body
//     module with its name and evidence, with a device model {read(a, size, dbg) -> value | undefined, write(a,
//     value, size) -> true when handled} or none; an access the model does not take is plain storage (H-PLAINREG:
//     a read gives what was last written there, 0 before; word-granular). An access to a block nobody declared is
//     refused as the machine's own devices refuse one: a stderr line and a bus error (fault 2), never a guess
//     (ARCHITECTURE.md "Unported paths throw");
//   - pc hooks: a stand-in at a function's entry returns through ret() as the function's own ret would (the call's
//     register list and frame from the call instruction before MDR); a hook that leaves the pc where it was is an
//     observer, and the instruction under it is stepped;
//   - the run loop: lab time follows the instruction count (A-NSPERINSN: nsPerInsn of lab time per instruction of core
//     0, a choice, not the chip's speed) and moves to the next device event when the body's idle hooks say so.
// The second core, when the body has one, is the machine's (src/core/cores.mjs): the body module starts it where its
// release is seen and serves its stops through the same hooks (onCore1Stop).
import { createMachine } from '../machine.mjs';
import * as mem from '../core/mem.mjs';
import { R, S, PC, MDR, D0, A0 } from '../core/cpu.mjs';
import { FlashView } from './flash.mjs';

export const h8 = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
// the register indices of cpu.mjs R, all of them (cpu.mjs names D0, A0 and the specials)
export const D1 = 1, D2 = 2, D3 = 3, A1 = 5, A2 = 6, A3 = 7;
export { R, S, PC, MDR, D0, A0 };
export { SP, PSW } from '../core/cpu.mjs';
const STUB_LO = 0x80000000, STUB_HI = 0xA0000000;      // the machine's lab-stub window (src/core/mem.mjs inStub)

export class BootLab {
  // rom: the main code block (MODELS rom_sha256), mapped as the machine maps it; blocks: the container's walked blocks
  // for the flash view; cores: createMachine's cores option (null: one core); ram: [{base, size, name}]
  constructor({ rom, blocks, cores = null, ram = [], nsPerInsn = 4, slice = 20000 }) {
    this.rom = rom;
    this.m = createMachine({ rom, insnLimit: 0, keepStderr: false, cores });
    this.flash = FlashView.fromBlocks(blocks);
    for (const r of ram) mem.addRegion({ base: r.base, size: r.size, kind: mem.K_RAM, off: mem.allocWindow(r.size), name: r.name });
    this.hooks = new Map();          // pc -> { fn, name, count }
    this.blocks = new Map();         // MMIO block (addr >>> 20) -> { name, dev }
    this.store = new Map();          // H-PLAINREG's storage: word address -> u32
    this.seen = new Map();           // the first access to each plain register: 'r|w address' -> { n, pc, v, w }
    this.wHooks = new Map();         // an exact MMIO address -> fn(value) on a CPU write (before the block's model)
    this.mmioLog = null;             // (dir, a, size, value) on every CPU access of a declared block, or null
    this.denied = [];                // the refused accesses: [dir, address, size, pc] (the first 64)
    this.nsPerInsn = nsPerInsn;
    this.slice = slice;              // instructions between two updates of lab time
    this.insnsAtClock = 0;
    this.scratch = 0x00010000;       // ret()'s return pads, in the machine's lab low RAM
    this.pads = new Map();
    this.stopReason = null;
    this.onTime = null;              // (labNs) after every move of lab time
    this.onCpu1 = false;             // a hook runs for the second core (onCore1Stop)
    mem.setStub({ read: (a, w, dbg) => this.mmioRead(a >>> 0, w, dbg), write: (a, v, w, dbg) => this.mmioWrite(a >>> 0, v, w, dbg) });
    // H-GATEANY: the interrupt controller presents at any instruction (src/dev/intc.mjs debug window +0x008 = 2), as
    // the second core's bank always does (H-CPU2GATE); the HLE labs gate core 0's at their own points
    this.m.devices.intc.dset(0x008, 2);
  }
  // ---- memory: debugger access (no side effects, no faults on RAM)
  rd(a, n) { const b = mem.dbgRead(a >>> 0, n); if (b === null) throw new Error('rd ' + h8(a)); return b; }
  r8(a) { return this.rd(a, 1)[0]; }
  r16(a) { const b = this.rd(a, 2); return b[0] | b[1] << 8; }
  r32(a) { const b = this.rd(a, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; }
  wr(a, bytes) { mem.dbgWrite(a >>> 0, bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)); }
  w8(a, v) { this.wr(a, [v & 255]); }
  w16(a, v) { this.wr(a, [v & 255, (v >>> 8) & 255]); }
  w32(a, v) { this.wr(a, [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  cstr(a, max = 256) {
    let s = '';
    for (let i = 0; i < max; i++) { let c; try { c = this.r8(a + i); } catch { break; } if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  // ---- MMIO
  // declare the 1 MiB block at base (its address >>> 20): name, and dev (a model) or null (plain storage)
  block(base, name, dev = null) {
    const k = base >>> 20;
    if ((base >>> 0) < STUB_LO || (base >>> 0) >= STUB_HI) throw new RangeError(`block ${name}: ${h8(base)} is outside the stub window`);
    if (this.blocks.has(k)) throw new Error(`block ${name}: ${h8(base)} is ${this.blocks.get(k).name}'s`);
    this.blocks.set(k, { name, dev });
  }
  // a block a machine device maps (a region): its accesses come here instead (the body has another device there)
  takeOver(base, name, dev = null) {
    const r = mem.findRegion(base); if (!r) throw new Error('takeOver: no region at ' + h8(base));
    r.dev = { read: (a, w, dbg) => this.mmioRead(a >>> 0, w, dbg), write: (a, v, w, dbg) => this.mmioWrite(a >>> 0, v, w, dbg) };
    this.block(base, `${name} (in place of ${r.name})`, dev);
  }
  deny(dir, a, w, v, dbg) {
    if (dbg) throw mem.BUS;
    if (this.denied.length < 64) this.denied.push([dir, a >>> 0, w, R[PC] >>> 0]);
    this.m.stderr(`boot-stub DENIED ${dir === 'r' ? 'read' : 'write'} ${h8(a)} size ${w}${dir === 'w' ? ` value ${h8(v)}` : ''} pc ${h8(R[PC])} (no declared block: src/boot)`);
    throw mem.BUS;
  }
  mmioRead(a, w, dbg) {
    const blk = this.blocks.get(a >>> 20);
    if (!blk) return this.deny('r', a, w, 0, dbg);
    let v;
    if (blk.dev) v = blk.dev.read(a, w, dbg);
    if (v === undefined) {
      const word = this.store.get((a & ~3) >>> 0) ?? 0;
      v = w === 4 ? word : w === 2 ? (word >>> (8 * (a & 2))) & 0xffff : (word >>> (8 * (a & 3))) & 0xff;
      if (!dbg) this.touch('r', a, w, v);
    }
    if (this.mmioLog && !dbg) this.mmioLog('r', a, w, v);
    return v;
  }
  mmioWrite(a, v, w, dbg) {
    if (dbg) return;
    const blk = this.blocks.get(a >>> 20);
    if (!blk) return this.deny('w', a, w, v, dbg);
    if (this.mmioLog) this.mmioLog('w', a, w, v);
    const wh = this.wHooks.get(a); if (wh) wh(v >>> 0);
    if (blk.dev && blk.dev.write(a, v, w) === true) return;
    const k = (a & ~3) >>> 0, old = this.store.get(k) ?? 0;
    const sh = 8 * (a & 3), mask = w === 4 ? 0xffffffff : w === 2 ? 0xffff << sh : 0xff << sh;
    this.store.set(k, ((old & ~mask) | ((v << sh) & mask)) >>> 0);
    this.touch('w', a, w, v);
  }
  touch(dir, a, w, v) {
    const key = `${dir} ${h8(a)}`, n = this.seen.get(key);
    if (n === undefined) this.seen.set(key, { n: 1, pc: R[PC] >>> 0, v: v >>> 0, w }); else n.n++;
  }
  // ---- hooks
  hook(pc, name, fn) { this.hooks.set(pc >>> 0, { fn, name, count: 0 }); this.bpDirty = true; }
  unhook(pc) { this.hooks.delete(pc >>> 0); this.bpDirty = true; }
  // Return from the function whose entry the CPU stands at (a hook at a function's first instruction): through the
  // `ret` / `rets` that matches the call instruction that got here (the return address is in MDR). A call d16 (cd) or
  // d32 (dd) to this pc gives its register list and frame; one to another pc (the hook stands inside the callee, or a
  // tail jump got here) gives its own, which the callee's entry shares (I); anything else was a `calls`: a plain rets.
  ret(d0, a0) {
    if (d0 !== undefined) R[D0] = d0 | 0;
    if (a0 !== undefined) R[A0] = a0 | 0;
    const ra = R[MDR] >>> 0, here = R[PC] >>> 0;
    let regs = -1, frame = 0;
    const b5 = this.rd(ra - 7, 7);
    const s16 = (lo, hi) => ((lo | hi << 8) << 16) >> 16;
    if (b5[2] === 0xCD && ((ra - 5 + s16(b5[3], b5[4])) >>> 0) === here) { regs = b5[5]; frame = b5[6]; }
    else if (b5[0] === 0xDD && ((ra - 7 + (b5[1] | b5[2] << 8 | b5[3] << 16 | b5[4] << 24)) >>> 0) === here) { regs = b5[5]; frame = b5[6]; }
    else if (b5[2] === 0xCD || b5[0] === 0xDD) { regs = b5[5]; frame = b5[6]; }
    if (regs < 0) { R[PC] = this.pad('rets', [0xF0, 0xFC]); return; }
    R[PC] = this.pad(`ret${regs}_${frame}`, [0xDF, regs, frame]);
  }
  pad(key, bytes) {
    let a = this.pads.get(key);
    if (a === undefined) { a = this.scratch; this.scratch += 4; this.wr(a, bytes); this.pads.set(key, a); }
    return a;
  }
  syncBp() {
    if (!this.bpDirty) return;
    this.m.setBreakpoints([...this.hooks.keys()]); this.bpDirty = false;
    if (this.cpu1Started) this.m.cores.addStops([...this.hooks.keys()].filter((p) => !this.m.cores.ctx[this.m.cores.second].halts.has(p)));
  }
  // A stop of the second core at a hook's pc (src/core/cores.mjs onStop): the same hook, run with that core's registers
  onCore1Stop(pc) {
    const h = this.hooks.get(pc >>> 0); if (!h) return 'step';
    h.count++; this.onCpu1 = true;
    try { h.fn(this, pc); } finally { this.onCpu1 = false; }
    return (R[PC] >>> 0) === (pc >>> 0) ? 'step' : 'go';
  }
  // ---- run: until `until()` is true, a fault, a hook's 'stop', maxInsns, maxLabMs of lab time or maxMs of wall time
  // (clock() is the host's wall clock in ms: performance.now). Returns {why, pc[, code]}.
  run({ maxInsns = Infinity, until = null, maxMs = Infinity, maxLabMs = Infinity, clock = () => performance.now() } = {}) {
    const m = this.m, labClock = m.devices.clock;
    const i0 = S.insns, t0 = clock(), lab0 = labClock.t; let iter = 0;
    this.stopReason = null;
    for (;;) {
      this.syncBp();
      if (S.insns - i0 >= maxInsns) return { why: 'limit', pc: R[PC] >>> 0 };
      if (this.stopReason) return { why: this.stopReason, pc: R[PC] >>> 0 };
      if (labClock.t - lab0 >= maxLabMs * 1e6) return { why: 'labtime', pc: R[PC] >>> 0 };
      if ((++iter & 1023) === 0 && clock() - t0 > maxMs) return { why: 'maxMs', pc: R[PC] >>> 0 };
      const r = m.cont({ budget: this.slice });
      if (r === 'paused') m.halt();
      const dn = S.insns - this.insnsAtClock;                  // A-NSPERINSN
      if (dn > 0) { this.insnsAtClock = S.insns; labClock.advance(labClock.t + dn * this.nsPerInsn, false); if (this.onTime) this.onTime(labClock.t); }
      if (r === 'paused') {
        if (until && until()) return { why: 'until', pc: R[PC] >>> 0 };
        if (clock() - t0 > maxMs) return { why: 'maxMs', pc: R[PC] >>> 0 };
        continue;
      }
      const st = m.lastStop();
      if (st.kind === 'break') {
        const pc = R[PC] >>> 0, h = this.hooks.get(pc);
        if (!h) return { why: 'break', pc };
        h.count++;
        const act = h.fn(this, pc);
        if (act === 'stop') return { why: 'hook:' + h.name, pc };
        if ((R[PC] >>> 0) === pc) {                             // an observer: step the instruction it stands on
          m.step();
          const s2 = m.lastStop();
          if (s2.kind === 'fault') return { why: 'fault', code: s2.code, pc: R[PC] >>> 0 };
        }
        continue;
      }
      if (st.kind === 'fault') return { why: 'fault', code: st.code, pc: R[PC] >>> 0 };
      return { why: st.kind, pc: R[PC] >>> 0 };
    }
  }
  idleSkip(ns) { const c = this.m.devices.clock; c.advance(c.t + ns, true); }
  labMs() { return this.m.devices.clock.t / 1e6; }
  regs() {
    const n = ['d0', 'd1', 'd2', 'd3', 'a0', 'a1', 'a2', 'a3', 'sp', 'pc', 'psw', 'mdr', 'lir', 'lar'];
    return n.map((k, i) => `${k}=${(i === 10 ? R[i] & 0xffff : R[i] >>> 0).toString(16)}`).join(' ');
  }
  stderrTail(n = 800) { return this.m.stderrTail(n); }
}
