// The E-PM2 (E101, firmware 1.6) in the boot lab (src/boot/bootlab.mjs): its firmware from the reset vector on both
// MN103 cores, to the camera application's shooting screen, its menus, playback and the card (docs/e101-boot-spec.md).
// Every address is the E-PM2 v1.6 build's (block 0 run at 0x7e421020; docs/model-survey.md row E101); tags as in
// docs/README.md: X executed in the boot lab, D read from the firmware, I inference, ? unknown. Stand-ins are S-*,
// harness steps H-*, assumptions A-* (each listed in docs/e101-boot-spec.md section 5 with its evidence).
//
// createE101({ rom, blocks, ...options }) -> the boot lab, set up and stopped at the reset vector; lab.run() starts it.
// rom: the main code block (MODELS.E101 rom_sha256); blocks: the .BIN's walked blocks (host/boot.mjs readBin). The
// options replace the environment the earlier drivers read; each is the stand-in's own:
//   log            (text) for the progress lines of the flash and fill stand-ins (default: none)
//   flashState     a saved state document (flashStateDoc's form), its flash ranges and RAM banks restored (S-FLASHWRITE)
//   flashWrites    false: S-FLASHWRITE and S-FLASHERASE off, the driver's own writes fail as without a chip
//   rtc            Unix seconds: S-RTC sets the clock at power-on (null: the clock is not set)
//   card           a card image (Uint8Array, src/boot/e101card.mjs buildFat16) behind S-SDCMD (null: no card)
//   cardDetect     the card-detect pin's level without a card (1: no card)
//   fast           true: the quick start runs (S-NOFAST off)
//   cam, img       true: the mechanism sequencer (S-CAM) / the IMG engine's wait (S-IMG) run natively
//   takeFake       the TAKE_FUNC commands S-TAKEAPI answers (default [0x19], live view's start)
//   apiFake        'queue:command' pairs S-TAKEAPI answers for other modules (default ['80:5', '80:1'])
//   tilt           [x, y, z] for S-ACC (16384 = 1 g; null: the native read, no sample)
//   faithfulLoad   false: the whole block 0 is in RAM at reset (default: only what the first-stage loader leaves)
//   sym            (pc) -> text, the name the error log gives a caller (default: its hex)
//   consoleOut     (char) for each character S-CONSOLE takes (default: none)
import { BootLab, h8, D1, A1 } from './bootlab.mjs';
import { R, S, PC, SP, PSW, MDR, D0, A0, C, N, V, Z, UNDEF, pswFlags } from '../core/cpu.mjs';
import * as mem from '../core/mem.mjs';
import { FlashView } from './flash.mjs';
import { systemController, adc, sdHost, displayController, gio, osdEngine } from './e101dev.mjs';
import { attachCard } from './e101card.mjs';
import { bytesBase64, base64Bytes } from '../util/bytes.mjs';

export const IMAGE_BASE = 0x7E421020;
// the reset: block 0's first byte at its run-time address, the reset stack in the on-chip SRAM (D: the reset head)
export const RESET = { pc: 0x7E421020, sp: 0x47001FFC, psw: 0 };
// the kernel's idle loops (`bra self` at 0x7e436825 and 0x7e43683d, reached from the kernel start 0x7e432a3f when no
// task is ready) and the boot task's after Usr0 (OlyTaSE 0x7e449621 drops it to priority 16 and it loops writing 8 to
// the halt word 0x8040, 0x7e44966c) (D)
export const IDLE = [0x7E436825, 0x7E43683D, 0x7E44966C];
// the MMIO blocks the firmware's start, menus, card and power-off use, as the boot lab declares them (X: every access
// of the runs of docs/e101-boot-spec.md section 7 lands in one; an access elsewhere is refused). A block with a model
// is src/boot/e101dev.mjs's; the others are plain storage (H-PLAINREG), named by the code that uses them
export const BLOCKS = [
  [0x80000000, 'flash memory controller (the [flashmem] driver: start block +0x1e498, command +0x1e440, D)'],
  [0x98000000, '? (two words the CPU 1 boot task writes and reads, 0x7e45d120)'],
  [0x98200000, 'serial channel (the E118 family\'s channel blocks 0x98200000..0x98600000, src/fw/board.mjs; I)'],
  [0x98300000, 'serial channel (I)'],
  [0x98400000, 'serial channel (I)'],
  [0x98500000, 'serial channel (I)'],
  [0x98600000, 'serial channel (I)'],
  [0x98700000, 'serial port of the debug console (its driver 0x7e44ad97 and putchar 0x7e44b051 beside it, I)'],
  [0x98800000, 'clock block (the E118 family\'s, src/fw/board.mjs; the reset main 0x7e421115 writes it first, I); +0xf0 CPU 1\'s release'],
  [0x98B00000, '? (the hardware-timer code 0x7e462252)'],
  [0x98D00000, 'boot control (+0x140 CPU 1\'s entry, D: the reset main 0x7e4213c4)'],
  [0x99700000, '? (reached from the kernel init 0x7e44a043)'],
  [0x99900000, '? (the camera power-up CAM_PW\'s driver 0x7e653ab1)'],
  [0x99A00000, '? (the camera power-up\'s driver 0x7e64dbdb)'],
  [0x99B00000, 'AE statistics unit (its driver 0x7e629854 names AE_SEM, D)'],
  [0x99C00000, '? (CAMAFD\'s driver 0x7e62a9a3)'],
  [0x99D00000, '? (SPRDRV\'s driver 0x7e64b364)'],
  [0x9A200000, 'stabiliser assist (STB_ASSIST_FUNC\'s driver 0x7e5db697, I)'],
  [0x9A300000, 'the mechanism\'s timing unit (the MEC layer, 0x7e510185, I)'],
  [0x9A400000, '? (0x7e5324b3, reached from Usr0)'],
  [0x9A500000, 'PWM unit (S-PWM\'s PER_PCONT requests 0x7e466435, IRQ 118, I)'],
  [0x9A600000, '? (0x7e50daaf, reached from Usr0)'],
  [0x9AB00000, '? (0x7f0a41b9, reached from Usr3 and MOV_BRIDGE)'],
  [0x9C000000, 'the IMG library\'s per-CPU window (cmp (0x8050): 0x9c000000 / 0x9e000000, D)'],
];
// S-FLASHWRITE's RAM banks: the MODE and EEROM settings banks' RAM images, 0x10000 bytes each (D)
const RAMBANKS = [['mode', 0x60404674], ['eerom', 0x603F4674]];
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function createE101({ rom, blocks, log = null, flashState = null, flashWrites = true, rtc = null, card = null, cardDetect = 1,
  fast = false, cam = false, img = false, takeFake = [0x19], apiFake = ['80:5', '80:1'], tilt = null, faithfulLoad = true,
  sym = (pc) => (pc >>> 0).toString(16), consoleOut = null } = {}) {
  const say = (s) => { if (log) log(s); };
  // two cores: CPU 1 is the second, its vectors in page 0x7e44 (src/core/cores.mjs vectorPage); the on-chip SRAM
  // 0x47000000 (the kernel's configuration, the reset stack, the SRAM code copy at 0x47001000, D) and the 1 MiB at
  // 0x28a00000 the cache purge reads 512 words of (0x7e45da9d, D: plain RAM, reads 0)
  const e = new BootLab({ rom, blocks, cores: { second: 1, quantum: 2000, vectorPage: 0x7E440000 },
    ram: [{ base: 0x47000000, size: 0x10000, name: 'e101.sram47' }, { base: 0x28A00000, size: 0x100000, name: 'e101.cache-purge' }] });
  e.model = 'E101';
  e.console = '';
  e.marks = [];
  const intc = e.m.devices.intc;
  // H-GNICR: the GnICR request flags (0x8940 + 4 level, bit 4) follow what each core's controller bank presents: the
  // kernel polls them (0x7e43369f waits for the other CPU's kick, D). Core 0's system page is lab low RAM, core 1's
  // its own (src/core/cores.mjs CORE_PAGE)
  e.corePage = [mem.LOW_OFF, e.m.cores.ctx[1].pages.get(0).rp];
  intc.onMask = (core, mask) => {
    const off = e.corePage[core]; if (off < 0) return;
    for (let l = 0; l < 7; l++) { const o = off + 0x8940 + 4 * l; if (mask & (1 << l)) mem.U8[o] |= 0x10; else mem.U8[o] &= ~0x10; }
  };
  // the device blocks: the five models, the plain ones
  e.ports = 0x0C;            // the system controller's ports: 2 high (no card), 3 high (the quick start's check)
  e.takeOver(0x98E00000, 'system controller', systemController(e, { rtc }));
  e.block(0x98C00000, 'ADC', adc(e));
  e.block(0x99000000, 'SD host', sdHost(e));
  e.block(0x9A900000, 'display controller', displayController(e));
  e.block(0x9A100000, 'GIO', gio(e));
  e.block(0x9AA00000, 'OSD draw engine', osdEngine(e));
  for (const [base, name] of BLOCKS) e.block(base, name);
  // H-FAITHFULLOAD: at reset only what the first-stage loader (not in the update file, ?) leaves is in RAM, block 0's
  // 0x7e421020..0x7e430000 (I: the reset head's first copy starts there); the rest comes with the firmware's own
  // loader copies through S-FLASHREAD0, so a patch in a range nothing loads is absent here, as on the camera
  if (faithfulLoad) {
    const z = new Uint8Array(0x100000), end = IMAGE_BASE + rom.length;
    for (let a = 0x7E430000; a < end; a += z.length) e.wr(a, z.subarray(0, Math.min(z.length, end - a)));
  }
  // S-CONSOLE: the debug serial putchar 0x7e44b051(d0 = char): kept in lab.console, sent to no UART
  e.hook(0x7E44B051, 'S-CONSOLE', () => { const c = String.fromCharCode(R[D0] & 0xff); e.console += c; if (consoleOut) consoleOut(c); e.ret(); });
  // the boot marks 0x7e426511(a0 = tag): observed
  e.hook(0x7E426511, 'boot-mark', () => { const t = e.cstr(R[A0] >>> 0, 8); e.marks.push([t, S.insns]); say(`[mark ${t}] @${S.insns}`); });
  // S-OSDFILL: the reset's memory clear 0x7e4213f7(d0 = start, d1 = end), and CPU 1's 0x7e426b5d, use the OSD engine's
  // fill command: [start, end) zeroed (the cached alias) and returned
  const fill = () => {
    const a = ((R[D0] & 0x3FFFFFFF) | 0x40000000) >>> 0, b = ((R[D1] & 0x3FFFFFFF) | 0x40000000) >>> 0;
    say(`[osdfill ${h8(a)}..${h8(b)}]`);
    if (b > a && b - a < 0x10000000) { const z = new Uint8Array(0x10000); for (let p = a; p < b; p += z.length) e.wr(p, z.subarray(0, Math.min(z.length, b - p))); }
    e.ret();
  };
  e.hook(0x7E4213F7, 'S-OSDFILL', fill);
  // S-FLASHREAD0: the early flash reader 0x7e4217e6(d0 = volume, a0 = flash source, a1 = destination, d1 = size) reads
  // the flash view (the container's blocks; other areas read 0xff: no adjustment data, no ROM pictures)
  e.hook(0x7E4217E6, 'S-FLASHREAD0', () => {
    const src = R[A0] >>> 0, dst = R[A1] >>> 0, n = R[D1] >>> 0;
    say(`[flashread0 vol ${R[D0]} ${h8(src)} -> ${h8(dst)} n=${h8(n)}]`);
    e.wr(dst, e.flash.read(src, n));
    e.ret(0);
  });
  // S-FLASHWRITE / S-FLASHERASE: the flash driver's two other primitives, WRITE 0x7e451b69(d0 = volume, a0 / a1 = flash
  // address and source buffer, d1 = size) and ERASE 0x7e4519c5(d0 = volume, a0 = flash address, d1 = size). Natively
  // they drive the flash chip through the BML layer and fail here (no chip: the settings store logs
  // DBG_PRM_PROC_*_SAVE_ERR, X). Stand-in: written and erased ranges are kept in the flash view, which S-FLASHREAD0
  // reads back; both return 0. flashStateDoc() is the state a host keeps between runs (host/boot.mjs): the written
  // flash pages and S-BANKRESTORE's RAM banks
  e.flashLog = []; e.flashWrites = [];
  const flashPut = (a, bytes) => { a = FlashView.norm(a); e.flash.write(a, bytes); e.flashWrites.push([a, bytes]); e.flashDirty = true; };
  if (flashState) for (const [a, b64] of flashState.flash) flashPut(a, base64Bytes(b64));
  e.flashDirty = false;
  // S-BANKRESTORE (A-POWEROFF: the camera saves the settings banks in its power-off sequence, which does not finish
  // here): the saved RAM images of the MODE and EEROM banks are written back when the firmware's own boot-time bank
  // save 0x7e4580bd is first entered; that save compares RAM with flash and writes the bank with its own checksum (D)
  let injected = false;
  e.hook(0x7E4580BD, 'S-BANKRESTORE', () => {
    if (injected) return; injected = true; e.bankSaveSeen = true;
    if (flashState && flashState.ram) for (const [k, a] of RAMBANKS) if (flashState.ram[k]) e.wr(a, base64Bytes(flashState.ram[k]));
  });
  e.flashStateDoc = () => {
    const pages = new Map();
    for (const [a, d] of e.flashWrites) for (let i = 0; i < d.length;) { const pa = ((a + i) & ~0xFFFF) >>> 0, off = (a + i) & 0xFFFF; pages.set(pa, null); i += Math.min(d.length - i, 0x10000 - off); }
    for (const pa of pages.keys()) pages.set(pa, e.flash.read(pa, 0x10000));
    const ram = {};
    if (e.bankSaveSeen && e.m.devices.clock.t > 100e6) for (const [k, a] of RAMBANKS) ram[k] = bytesBase64(e.rd(a, 0x10000));
    e.flashDirty = false;
    return { flash: [...pages].map(([a, d]) => [a, bytesBase64(d)]), ram: e.bankSaveSeen ? ram : (flashState && flashState.ram) };
  };
  if (flashWrites) {
    e.hook(0x7E451B69, 'S-FLASHWRITE', () => {
      let dst = R[A0] >>> 0, src = R[A1] >>> 0; const n = R[D1] >>> 0;
      if (((src & 0x3FFFFFFF) | 0x40000000) < 0x48000000 && ((dst & 0x3FFFFFFF) | 0x40000000) >= 0x60000000) [dst, src] = [src, dst];
      if (e.flashLog.length < 400) e.flashLog.push(`${e.labMs().toFixed(1)} write ${h8(dst)} <- ${h8(src)} n=${h8(n)} from ${h8(R[MDR])}`);
      flashPut(dst, e.rd(src, n).slice());
      e.ret(0);
    });
    e.hook(0x7E4519C5, 'S-FLASHERASE', () => {
      const a = R[A0] >>> 0, n = R[D1] >>> 0;
      if (e.flashLog.length < 400) e.flashLog.push(`${e.labMs().toFixed(1)} erase ${h8(a)} n=${h8(n)} from ${h8(R[MDR])}`);
      if (n <= 0x1000000) flashPut(a, new Uint8Array(n).fill(0xFF));
      e.ret(0);
    });
  }
  // H-IDLE: at the idle loops CPU 1 halts until its bank presents an interrupt (src/core/cores.mjs halts); on CPU 0
  // lab time moves to the next device event, at most 50 ms (while CPU 1 has work, CPU 1 runs a turn and time moves by
  // its quantum)
  const idle = () => {
    if (e.onCpu1) return;
    const clock = e.m.devices.clock, c1 = e.m.cores;
    e.idleHits = (e.idleHits || 0) + 1;
    if (S.irqReq) return;
    if (e.cpu1Started && c1.runnable()) { c1.turn(c1.quantum); clock.advance(clock.t + c1.quantum * e.nsPerInsn, false); return; }
    if (e.onIdle && e.onIdle() === 'stop') return 'stop';
    const before = clock.t;
    clock.advance(clock.t + 50e6, true);
    if (e.onTime) e.onTime(clock.t);
    e.idleNs = (e.idleNs || 0) + clock.t - before;
  };
  for (const pc of IDLE) e.hook(pc, 'idle', idle);
  // S-ROLC: in the soft-float multiply 0x7e5018e8, `rol d3` at 0x7e5018fc reads C, which the udf04 before it leaves
  // undefined in om-emu's model (docs/mn10300-isa-spec.md 2.3: a consumer of an undefined flag faults). The bit rol
  // takes from C lands in d3's bit 0, which the `lsr 24,d3` after it drops: any C gives the same d3 (D). The flag is
  // marked defined (its value as the PSW holds it) and the rol runs
  e.hook(0x7E5018FC, 'S-ROLC', () => { R[UNDEF] &= ~C; });
  // S-DIV0: `divu d0,d1` at 0x7e6a3203 (in 0x7e6a318e, one caller) divides by the word at (20,a0), 0 at the start (X:
  // once in every boot). The MN103 does not trap; the manual leaves the quotient undefined and sets V
  // (docs/mn10300-isa-spec.md 4.6), om-emu stops (fault 6, FIDELITY-NOTES.md "Faults"). Stand-in for that divide alone
  // when the divisor is 0: d1 = 0xffffffff (A-DIV0, the value the earlier drivers gave; the chip's is ?), MDR kept, N and
  // V set, Z clear, C undefined; the divide is skipped. A divisor not 0 divides natively
  e.div0 = 0;
  e.hook(0x7E6A3203, 'S-DIV0', () => {
    if (R[D0] !== 0) return;
    R[D1] = -1; pswFlags(V | N, Z | N | V, C); e.div0++; R[PC] = 0x7E6A3205 | 0;
  });
  // S-GIOIN: the GIO input read 0x7e46144e(d0 = pin id: its type in bits 24..27, its number in the low 16) returns
  // lab.pins' level for a pin listed there (the buttons' pins of UI_IN's tables, released = 1; 0x7d the HDMI detect and
  // 0xa1 the video-out detect, 1 = not connected (the quick start 0x7e5026e6, 0x7e502753); 0xbe the card detect, 1 =
  // no card (0x7e5cc9c8), D); every other pin reads natively (the GIO block: plain storage, 0 unless written)
  e.pins = new Map([[0x35, 1], [0x32, 1], [0x28, 1], [0x41, 1], [0x42, 1], [0x72, 1], [0x74, 1], [0x7D, 1], [0xA1, 1], [0xBE, cardDetect]]);
  e.pinReads = new Map(); e.noFast = !fast;
  e.hook(0x7E46144E, 'S-GIOIN', () => {
    const id = R[D0] >>> 0; e.pinReads.set(id, (e.pinReads.get(id) || 0) + 1);
    // S-NOFAST (lab.noFast): the quick start (USR_FAST_APP: lens set-up and live view before the application is up) is
    // declined the way the firmware itself declines it, "ErrLeOK": its read of the OK button's pin 0x35 at 0x7e5026fe
    // (the call returning to 0x7e502705) returns 0, held. The application then starts the camera on its normal path (X)
    if (e.noFast && id === 0x35 && (R[MDR] >>> 0) === 0x7E502705) { e.ret(0); return; }
    if (e.pins.has(id)) e.ret(e.pins.get(id));
  });
  // S-PWM: the two PWM requests to the PER_PCONT task (0x7e466435, and the duty setter 0x7e466448(d0 = percent), the
  // LCD backlight) wait for the PWM unit's completion (IRQ 118), which is not modelled: both return 0
  e.pwmDuty = null;
  e.hook(0x7E466435, 'S-PWM', () => { e.ret(0); });
  e.hook(0x7E466448, 'S-PWM-duty', () => { e.pwmDuty = R[D0] & 0xff; e.ret(0); });
  // S-BC: a transaction with the BC (the H8 body controller, 0x7e53e792(a0 = request {callback, .., u16 command at
  // +8})) is answered at once: the request's callback is posted with the result 0 and the reply bytes the request
  // holds are left as they are (zero). No H8 is modelled
  e.bcLog = [];
  e.hook(0x7E53E792, 'S-BC', () => { const q = R[A0] >>> 0; e.bcLog.push(e.r16(q + 8).toString(16)); e.post(e.r32(q), q, 0); e.ret(0); });
  // S-SDCMD: the SD card's command exchange 0x7e5ceabb(a0 = host context, a1 = command record) starts a command on the
  // SD host and waits for its interrupt. With a card (src/boot/e101card.mjs) the card answers; without one, a host
  // set-up record (type other than 3..5) succeeds and a card command gets no response, 0x1405, the driver's response
  // time-out (it tests it after CMD8 at 0x7e5ccdc3, D)
  e.sdLog = [];
  e.sdCmd = null;
  e.hook(0x7E5CEABB, 'S-SDCMD', () => {
    const c = R[A1] >>> 0;
    if (e.sdLog.length < 200) e.sdLog.push(hex(e.rd(c, 96)));
    const type = e.r16(c + 14);
    const st = e.sdCmd ? e.sdCmd(c, R[A0] >>> 0) : (type >= 3 && type <= 5 ? 0x1405 : 0);
    if (e.sdCmd) e.w16(c + 88, st);
    e.ret(st);
  });
  // S-CARD: a card image attaches the card model at this seam and pulls the card-presence port (system controller
  // port 2) low, card inserted. The asynchronous users (block reads and writes with a completion callback,
  // 0x7e5cd934) submit their record straight to the driver's queue 0x7e5ce3e1(a0 = record): the same card serves it,
  // and the record's callback (+8)(a0 = record, d0 = status) is posted as the host interrupt would call it
  if (card) {
    attachCard(e, card);
    e.ports &= ~4;
    e.hook(0x7E5CE3E1, 'S-SDCMD-async', () => {
      const c = R[A0] >>> 0, st = e.sdCmd(c);
      if (e.sdLog.length < 200) e.sdLog.push(hex(e.rd(c, 96)));
      e.w16(c + 88, st);
      const cb = e.r32(c + 8); if (cb) e.post(cb, c, st);
      e.ret(0);
    });
  }
  // S-BATT: the battery classifier 0x7e53963a(d0 = ADC reading, d1) -> 0x100 / 0x200 / d1 compares the reading with
  // thresholds from the adjustment data, which the boot lab does not have: always 0x100, the class for which the
  // caller 0x7e53903c sets the level to 100 (the quick start otherwise stops with "ErrLeBat", X)
  e.hook(0x7E53963A, 'S-BATT', () => { e.ret(0x100); });
  // observer: the firmware's error log 0x7e426d4b(d0 = code, the stack words its arguments); the first 3 of each code
  // and caller kept, 500 at most
  e.errLog = [];
  e.errSeen = new Map();
  e.hook(0x7E426D4B, 'errlog', () => {
    const k = `${R[D0] >>> 0}:${R[MDR] >>> 0}`, n = (e.errSeen.get(k) || 0) + 1; e.errSeen.set(k, n);
    if (n <= 3 && e.errLog.length < 500) e.errLog.push(`${e.labMs().toFixed(1)} ${e.onCpu1 ? 'c1 ' : ''}${h8(R[D0])} from ${sym(R[MDR])} args ${h8(e.r32((R[SP] >>> 0) + 4))} ${h8(e.r32((R[SP] >>> 0) + 8))}`);
  });
  // observer: the application's event loop (the OXF thread loop 0x7eba74bb): the id of each event taken (d0 at 0x7eba752b)
  e.evLog = [];
  e.hook(0x7EBA752B, 'oxf-event', () => { if (e.evLog.length < 20000) e.evLog.push([e.labMs(), (R[D0] << 16) >> 16]); });
  // observers: the camera API's asynchronous calls, api_exec_start 0x7e67e493(d0 = function, d1 = event, a0 = packet),
  // and their completions, api_exec_post 0x7e67e5bb
  e.apiLog = [];
  e.hook(0x7E67E493, 'api_exec_start', () => { if (e.apiLog.length < 5000) e.apiLog.push(`${e.labMs().toFixed(1)} start fn=${(R[D0] >>> 0).toString(16)} ev=${(R[D1] >>> 0).toString(16)} from ${(R[MDR] >>> 0).toString(16)}`); });
  e.hook(0x7E67E5BB, 'api_exec_post', () => { if (e.apiLog.length < 5000) e.apiLog.push(`${e.labMs().toFixed(1)} post d0=${(R[D0] >>> 0).toString(16)} d1=${(R[D1] >>> 0).toString(16)} from ${(R[MDR] >>> 0).toString(16)}`); });
  // observers: the file task FILECLBK: each command it takes (0x7e5c1b5b: the command word at (12,sp)) and each result
  // it replies (0x7e5c1b9f: d0)
  e.fileLog = [];
  e.hook(0x7E5C1B5B, 'fileclbk-cmd', () => { if (e.fileLog.length < 3000) e.fileLog.push(`${e.labMs().toFixed(1)} cmd ${h8(e.r32((R[SP] >>> 0) + 12))} ${h8(e.r32((R[SP] >>> 0) + 4))} ${h8(e.r32((R[SP] >>> 0) + 8))} ${h8(e.r32((R[SP] >>> 0) + 16))}`); });
  e.hook(0x7E5C1B9F, 'fileclbk-ret', () => { if (e.fileLog.length < 3000) e.fileLog.push(`${e.labMs().toFixed(1)}   -> ${(R[D0] & 0xffff).toString(16)}`); });
  // observer: the USR_FAST_APP log 0x7e503a6e(a0 = text)
  e.fastLog = [];
  e.hook(0x7E503A6E, 'usrfast-log', () => { e.fastLog.push(`${e.labMs().toFixed(1)} ${e.cstr(R[A0] >>> 0, 40)}`); });
  // S-DMA: the CPU's DMA channels (registers 0x8500.., the driver: reserve 0x7e425fa8, start 0x7e426045(a0 = {src, dst,
  // length, .., u8 mode at +16, u8 at +17}), finish 0x7e42627b) copy .data at reset and serve three other callers. The
  // registers are plain RAM here (the driver then logs errors 0x19000c0x and copies nothing, X), so the three calls are
  // stood in: the transfer (mode 2: a fill with the byte at +17) is done in the start call and each returns 0
  e.dmaLog = [];
  e.hook(0x7E425FA8, 'S-DMA-reserve', () => { e.ret(0); });
  e.hook(0x7E426045, 'S-DMA', () => {
    const d = R[A0] >>> 0, src = e.r32(d), dst = e.r32(d + 4), len = e.r32(d + 8), mode = e.r8(d + 16), b17 = e.r8(d + 17);
    e.dmaLog.push({ src: h8(src), dst: h8(dst), len, mode, b17, pc: h8(R[MDR]) });
    if (len > 0 && len <= 0x4000000) e.wr(dst, mode === 2 ? new Uint8Array(len).fill(b17) : e.rd(src, len).slice());
    e.ret(0);
  });
  e.hook(0x7E42627B, 'S-DMA-finish', () => { e.ret(0); });
  // lab.post(fn, a0, d0): have the firmware call fn(a0, d0) from interrupt context, through its own deferred-call ring 0
  // (0x60415538: 32 entries {fn, a0, u16 d0}, head +384, tail +388; post 0x7e45f219, runner 0x7e45f2a2 from the IRQ 23
  // handler 0x7e45f242, D). The stand-ins deliver their completions so, as a driver's interrupt would
  e.post = (fn, a0 = 0, d0 = 0) => {
    const ring = 0x60415538, head = (e.r32(ring + 384) + 1) & 31;
    if (head === e.r32(ring + 388)) throw new Error('post: the deferred-call ring is full');
    e.w32(ring + 384, head);
    e.w32(ring + head * 12, fn); e.w32(ring + head * 12 + 4, a0); e.w16(ring + head * 12 + 8, d0);
    e.store.set(0x9A1000F4, 1); intc.setLine(23, true);
  };
  // S-IIC: the I2C layer's transfers (write 0x7e463275(d0 = channel, a0 = buffer, d1 = length); read 0x7e4632aa(d0 =
  // channel, d1 = tx length, a0 = tx buffer, a1 = rx buffer, (36,sp) = rx length)) are served by lab.i2cDev(ch, tx,
  // rxlen) -> rx bytes (default: every device reads 0); the layer's own completion hooks (0x7e4632ff tx done,
  // 0x7e463334 rx done) are posted as the SIO interrupt would call them, on a channel in asynchronous mode
  e.i2cLog = [];
  e.i2cDev = (ch, tx, rxlen) => new Uint8Array(rxlen);
  const i2cAsync = (ch) => e.r16(0x60416374 + 2 * ch) === 1;
  e.hook(0x7E463275, 'S-IIC-write', () => {
    const ch = R[D0] & 0xff, len = R[D1] & 0xffff, tx = e.rd(R[A0] >>> 0, len).slice();
    e.i2cLog.push({ ch, tx: hex(tx), pc: R[MDR] >>> 0 });
    e.i2cDev(ch, tx, 0);
    if (i2cAsync(ch)) { e.w16(0x6041637C + 4 * ch, 1); e.post(0x7E4632FF, 0, ch); } else e.w16(0x6041637C + 4 * ch, 0);
    e.ret(0);
  });
  e.hook(0x7E4632AA, 'S-IIC-read', () => {
    const ch = R[D0] & 0xff, txlen = R[D1] & 0xffff, rxlen = e.r32((R[SP] >>> 0) + 36) & 0xffff, rxbuf = R[A1] >>> 0;
    const tx = e.rd(R[A0] >>> 0, txlen).slice(), rx = e.i2cDev(ch, tx, rxlen);
    e.i2cLog.push({ ch, tx: hex(tx), rx: hex(rx), pc: R[MDR] >>> 0 });
    e.wr(rxbuf, rx);
    if (i2cAsync(ch)) { e.w16(0x6041637E + 4 * ch, 1); e.post(0x7E463334, 0, ch); } else e.w16(0x6041637E + 4 * ch, 0);
    e.ret(0);
  });
  // S-SIO: the SIO client transfer start 0x7e469cdf(a0 = request {u8 channel, u8 direction (1 write, 2 read), u8 tx
  // length, u8 rx length, tx buffer, rx buffer, tx callback or -1, its argument, rx callback}), used by the LCD panel,
  // the lens, the BC (H8) and the audio codec. The bytes go to lab.sioDev(ch, tx, rxlen) -> rx (default: zeros); the
  // driver's completion hooks (0x7e469d76 tx, 0x7e469d93 rx) are posted as the channel's interrupt would call them
  e.sioLog = [];
  e.sioDev = (ch, tx, rxlen) => new Uint8Array(rxlen);
  e.hook(0x7E469CDF, 'S-SIO', () => {
    const q = R[A0] >>> 0, ch = e.r8(q), dir = e.r8(q + 1), txlen = e.r8(q + 2), rxlen = e.r8(q + 3);
    const tx = (dir & 1) ? e.rd(e.r32(q + 4), txlen).slice() : new Uint8Array(0);
    const rx = (dir & 2) ? e.sioDev(ch, tx, rxlen) : new Uint8Array(0);
    if (e.sioLog.length < 4000) e.sioLog.push({ ch, dir, tx: hex(tx), rx: hex(rx), pc: (R[MDR] >>> 0).toString(16) });
    const txs = 0x60419FDC + 8 * ch, rxs = 0x6041A00C + 8 * ch;
    e.w32(txs, 0); e.w32(txs + 4, 0); e.w32(rxs, 0); e.w32(rxs + 4, 0);
    if (dir & 1) {
      const cb = e.r32(q + 12);
      if (cb !== 0xFFFFFFFF) { e.w32(txs, cb); e.w32(txs + 4, e.r32(q + 16)); }
      e.post(0x7E469D76, 0, ch);
    }
    if (dir & 2) { e.wr(e.r32(q + 8), rx); e.w32(rxs, e.r32(q + 20)); e.w32(rxs + 4, q); e.post(0x7E469D93, 0, ch); }
    e.ret(0);
  });
  // S-SIORAW: the raw SIO driver under the hot-shoe (external flash) protocol: the tx start 0x7e468324(d0 = channel,
  // d1 = length, a0 = bytes) completes at once (the channel's tx callback 0x6041762c[ch] is posted); the rx start
  // 0x7e4686e8 never completes: no device answers, and the firmware's own time-out ends the exchange ("no flash", X)
  e.sioRawLog = [];
  e.hook(0x7E468324, 'S-SIORAW-tx', () => {
    const ch = R[D0] & 0xff, len = R[D1] & 0xffff, tx = e.rd(R[A0] >>> 0, len).slice();
    if (e.sioRawLog.length < 500) e.sioRawLog.push(`${e.labMs().toFixed(1)} tx ch${ch} ${hex(tx)}`);
    const cb = e.r32(0x6041762C + 4 * ch); if (cb) e.post(cb, 0, ch);
    e.ret(0);
  });
  e.hook(0x7E4686E8, 'S-SIORAW-rx', () => { if (e.sioRawLog.length < 500) e.sioRawLog.push(`${e.labMs().toFixed(1)} rx ch${R[D0] & 0xff} len ${R[D1] & 0xffff}: no answer`); e.ret(0); });
  // S-CAM: the requests to the mechanism sequencer "cam" (cam.c 0x7e628303(a0 = packet {u16 command, u8, u8 mode, ..,
  // +40 callback(a0 = packet, d0 = status), +52 the caller's context})): commands 3..0x7f are answered "done, status 0"
  // through the packet's callback from interrupt context; the sequencer itself (the shutter's charge motor, the
  // magnets and the aperture through the H8, the photo-interrupters) does not run. Command 7 (the exposure values for
  // the next live-view frame) is answered one frame (A-FRAME) later. cam: true lets the real sequencer run (it ends in
  // "Damage 3b83" after 1.5 s: the shutter never reports its position, X)
  e.camLog = [];
  if (!cam) e.hook(0x7E628303, 'S-CAM', () => {
    const p = R[A0] >>> 0, cmd = e.r16(p), cb = e.r32(p + 40);
    if (e.camLog.length < 300 && cmd !== 7) e.camLog.push(`${e.labMs().toFixed(1)} cmd ${cmd} b2=${e.r8(p + 2)} mode ${e.r8(p + 3)} from ${(R[MDR] >>> 0).toString(16)}`);
    if (cmd < 3 || cmd > 0x7f) return;
    if (cb) { if (cmd === 7) e.at(e.labMs() + 16.683, () => e.post(cb, p, 0)); else e.post(cb, p, 0); }
    e.ret(0);
  });
  // S-TAKEAPI: the camera API messages to the TAKE_FUNC task (queue 113) whose command is in takeFake are not sent. The
  // hook stands on api_exec_start's queue write 0x7e67e502 (OlyQeWr(d0 = queue, a0 -> {record, length}, d1 =
  // time-out)); for a faked command the same call writes the reply a worker would send: the 12-byte record {u16 status
  // 0, .., u32 event, 0} to queue 6 (API_EVENT). Command 0x19 = api_tft_Start_Through (live view's start): the
  // application believes live view runs; no sensor, IMG engine, AE / AF / WB or face detection starts. apiFake: the
  // same for other modules, 'queue:command' (80:5 = api_play_Play_Rom, PLAY_MAIN showing a ROM picture, the menus'
  // background, through the IMG engine: answered done, nothing shown on the video plane)
  e.takeFake = new Set(takeFake);
  e.apiFake = new Set(apiFake);
  e.takeLog = [];
  let takeSlot = 0;
  e.hook(0x7E68522D, 'play-rom-no', () => { e.romNo = R[D1] & 0xffff; });     // observer: api_play_Play_Rom(d0 = kind, d1 = the ROM picture)
  e.hook(0x7E67E502, 'S-TAKEAPI', () => {
    const sp = R[SP] >>> 0, m = e.r32(sp + 24), q = R[D0] & 0xffff, cmd = e.r32(m + 8), ev = e.r32(m + 4);
    const fake = (q === 113 && e.takeFake.has(cmd)) || e.apiFake.has(`${q}:${cmd.toString(16)}`);
    if (e.takeLog.length < 2000) e.takeLog.push(`${e.labMs().toFixed(1)} queue ${q} cmd ${cmd.toString(16)} event ${ev.toString(16)} data ${e.r32(m + 12).toString(16)} ${e.r32(m + 16).toString(16)}${fake ? ' FAKED' : ''}`);
    if (q === 80 && cmd === 5 && fake) e.videoRom = e.romNo; else if (q === 113 && cmd === 0x19) e.videoRom = null;
    if (!fake) return;
    const a = 0x00012000 + 16 * (takeSlot++ & 63);          // the reply record, in lab low RAM
    e.w32(a, 0); e.w32(a + 4, ev); e.w32(a + 8, 0);
    e.w32(sp + 24, a); e.w32(sp + 28, 12); R[D0] = 6;
  });
  // S-IMG: a job of the IMG engine's driver (0x7e544bb5 -> 0x7e545590(d0 = event flag, a0 = request {.., u16 result at
  // +104, u8 type at +194})) is prepared and started by the firmware (its register writes go to plain storage), then
  // waits on its event flag for bit 1, "finished" (the engine's interrupt), 1000 ms time-out (error 0x12010002). No IMG
  // engine is modelled: the wait at 0x7e5455bf is answered at once with "finished, result 0"; no pixel is processed.
  // img: true runs the wait natively
  e.imgLog = [];
  if (!img) e.hook(0x7E5455BF, 'S-IMG', () => {
    const sp = R[SP] >>> 0, req = R[A0 + 2] >>> 0;       // a2: the request
    if (e.imgLog.length < 500) e.imgLog.push(`${e.labMs().toFixed(1)} type ${e.r8(req + 194)}`);
    e.w32(sp + 12, 2); e.w16(req + 104, 0); R[D0] = 0; R[PC] = 0x7E5455C6 | 0;
  });
  // S-ACC (off unless tilt): the accelerometer read 0x7e4583bf(d0 = unit, a0 -> three s32 words x, y, z) of the
  // PER_SLOPE task (the level gauge). Natively it takes a sample from a ring (0x7e4585dc, write index 0x604148c0) the
  // chip's sampling fills; no chip answers here, so the ring stays empty and the task sleeps 16 ms and tries again for
  // ever (the gauge shows its bars at rest, X). With lab.tilt = [x, y, z] the ring read answers "no sample" once (the
  // firmware's own 16 ms sleep paces the loop) and "sample" the next time, and at the function's exit 0x7e4584a4 the
  // three output words are lab.tilt, status 0
  e.tilt = tilt;
  let accPhase = 0;
  e.hook(0x7E4585DC, 'S-ACC-ring', () => { if (!e.tilt) return; accPhase ^= 1; e.ret(accPhase ? 1 : 0); });
  e.hook(0x7E4584A4, 'S-ACC-out', () => { if (!e.tilt) return; const a = R[A0 + 3] >>> 0; e.w32(a, e.tilt[0] | 0); e.w32(a + 4, e.tilt[1] | 0); e.w32(a + 8, e.tilt[2] | 0); R[D0 + 3] = 0; });
  // lab.at(labMs, fn): fn(lab) once when lab time reaches labMs (scripted inputs, S-CAM's command 7)
  e.sched = [];
  e.at = (ms, fn) => { e.sched.push([ms * 1e6, fn]); e.sched.sort((a, b) => a[0] - b[0]); };
  e.onTime = (t) => { while (e.sched.length && e.sched[0][0] <= t) e.sched.shift()[1](e); };
  // H-CPU1START: the reset main stores CPU 1's entry in 0x98d00140 and writes 1 to 0x988000f0 (0x7e4213c4..0x7e4213d9,
  // D): the second core starts there, the same hooks serving its stops, its idle loops its halts, and CPU 1's request
  // loop (its task at 0x7e44eb33, priority 15, reads only the request words 0x8ff0008c..0x8ff000af) a poll: CPU 1 sleeps
  // there until one of them changes or an interrupt arrives (H-CPU2POLL)
  e.wHooks.set(0x988000F0, (v) => {
    if (!(v & 1) || e.cpu1Started) return;
    const pc = e.store.get(0x98D00140) >>> 0;
    say(`[cpu1 released at ${h8(pc)}]`);
    e.m.cores.start(pc, 0, { stops: [...e.hooks.keys()].filter((p) => !IDLE.includes(p)), halts: IDLE, polls: [[0x7E44EB5B, 0x8FF0008C, 0x24]] });
    e.m.cores.onStop = (pc2) => e.onCore1Stop(pc2);
    e.m.cores.interleave = true;
    e.cpu1Started = true;
  });
  e.hook(0x7E426B5D, 'S-OSDFILL(cpu1)', fill);
  // the reset
  R[PC] = RESET.pc | 0; R[SP] = RESET.sp | 0; R[PSW] = RESET.psw;
  return e;
}

// The kernel's static task table on each CPU (the uITRON kernel family of docs/om1-kernel-spec.md, checked on the
// E-PM2: the KCB pointer per CPU at 0x8ff00004 + 4 cpu, its +124 the static task table (28-byte rows: id, .., entry at
// +12), its +204 the TCB pointer array; a TCB's +12 state, +16 id, +24 sp, D): [{id, tcb, state, entry, name, sp, words}].
// names: a Map entry -> name (host/boot.mjs taskNames), or none
const STATES = { 1: 'RUN', 2: 'RDY', 4: 'WAI', 8: 'SUS', 12: 'WAS', 16: 'DMT' };
export function tasks(e, cpu = 0, names = null) {
  const kcb = e.r32(0x8FF00004 + 4 * cpu), table = e.r32(kcb + 124), arr = e.r32(kcb + 204), out = [];
  for (let i = 0; i < 400; i++) {
    const id = e.r32(table + 28 * i); if (!id) break;
    const tcb = e.r32(arr + 4 * ((id & 0xfff) - 1));
    if (tcb < 0x60000000) continue;
    const st = e.r16(tcb + 12), entry = e.r32(table + 28 * i + 12);
    out.push({ id, tcb, state: STATES[st] ?? st, entry, name: names?.get(entry) ?? '?', sp: e.r32(tcb + 24), words: Array.from({ length: 16 }, (_, k) => e.r32(tcb + 4 * k)) });
  }
  return out;
}
export function taskReport(e, cpu = 0, { all = false, names = null } = {}) {
  return tasks(e, cpu, names).filter((t) => all || t.state !== 'DMT').map((t) => `${t.id.toString(16).padStart(4)} ${String(t.state).padEnd(3)} ${t.name.slice(0, 22).padEnd(22)} tcb=${t.tcb.toString(16)} sp=${t.sp.toString(16)} w=${t.words.slice(0, 12).map((w) => w.toString(16)).join(',')}`).join('\n');
}
