#!/usr/bin/env node
// The boot lab (src/boot/, docs/e101-boot-spec.md): a body's firmware from its reset vector, its start reported, its
// update path, its menus driven by keys and composed into screenshots, its menu tree crawled. One body boots: E101
// (E-PM2), the default model here (--model; OM_EMU_MODEL).
//   node emu/bin/boot.mjs report [--ms 2000]                      the start: console, tasks, events, error log, stand-ins
//   node emu/bin/boot.mjs update [--ms 3000] [--no-ok] [--watch HEX[:NAME]]...   power-on with OK held: the update path
//   node emu/bin/boot.mjs play OUTDIR STEP...                     scripted inputs and screenshots (OUTDIR/NAME.png)
//   node emu/bin/boot.mjs crawl OUTDIR NAME STEP...               the menu tree from the screen the steps reach
// Common options:
//   --bin FILE        the .BIN (default: the model's in BLOBS.sha256, fw/old/OLY_E_101_1600_0000_0000.BIN): stock or a
//                     patched build (the report names which); its OE blocks are the flash (host/boot.mjs readBin)
//   --state FILE      the kept state (the settings banks): loaded at the start, saved at the end (play; crawl reads it)
//   --card DIR        an SD card with a FAT16 image built from DIR (S-CARD); --card-img FILE uses and rewrites an image
//   --rtc TIME        the clock set at power-on: Unix seconds or 2026-11-14T12:00:00 (S-RTC; default: not set)
//   --tilt X,Y,Z      S-ACC's sample (16384 = 1 g)
//   --fast            the quick start runs (S-NOFAST off); --cam, --img: S-CAM, S-IMG off (the firmware's own)
//   --take-fake HEX,...  S-TAKEAPI's TAKE_FUNC commands (default 19; none); --api-fake Q:C,...  (default 80:5,80:1; none)
//   --no-flash-write  S-FLASHWRITE and S-FLASHERASE off; --card-detect 0|1: the card-detect pin without a card
//   --boot-ms MS      play and crawl: the lab time before the first step (default 1500)
// Play steps: w:MS (run lab time), key:NAME[:MS] (press for MS, default 120, release, then 400 ms), pin:HEX:LEVEL,
// adc:CH:VALUE (CH * for every input), port:HEX (the system controller's port levels), tilt:X:Y:Z or tilt:off,
// shot:NAME. Play options: --gui-log 1|2 (the GUI's event lines between steps), --gui-lines N, --flash-log,
// --card-log N. Crawl options: --depth (4), --maxlist (140), --maxshots (4000), --budget (150), --topmax (1000).
// Exit status: report 0 when both kernels run, the start tasks Usr0..Usr4 finished and no fault (STAGE 2: PASS), 1 when
// not; play and crawl 0 done, 2 a step stopped the run or was not understood; 2 a usage error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs, UsageError } from '../checks/lib/args.mjs';
import { takeModel, importLab } from '../host/modelarg.mjs';
// (not checks/lib/env.mjs: it imports the HLE lab, which does not load on a body without a port; a usage error is
// reported here as its exitFor does: 'PROG: message' and the usage line, exit 2)

const PROG = 'boot.mjs', BOOTS = { E101: '../src/boot/e101.mjs' };
process.env.OM_EMU_MODEL ??= 'E101';
const argv = takeModel(PROG, process.argv.slice(2));
const MODEL = process.env.OM_EMU_MODEL;
const fail = (code, msg) => { process.stderr.write(`${PROG}: ${msg}\n`); process.exit(code); };
if (!BOOTS[MODEL]) fail(2, `${MODEL} does not boot from reset here (the boot lab has ${Object.keys(BOOTS).join(', ')}; the HLE lab's play tool is bin/play.mjs)`);

const COMMON = [
  { opt: '--bin', type: 'path' }, { opt: '--state', type: 'path' }, { opt: '--card', type: 'path' }, { opt: '--card-img', type: 'path' },
  { opt: '--rtc', type: 'str' }, { opt: '--tilt', type: 'str' }, { opt: '--fast', type: 'flag' }, { opt: '--cam', type: 'flag' },
  { opt: '--img', type: 'flag' }, { opt: '--take-fake', type: 'str' }, { opt: '--api-fake', type: 'str' }, { opt: '--no-flash-write', type: 'flag' },
  { opt: '--card-detect', type: 'int' }, { opt: '--boot-ms', type: 'number', default: 1500 },
];
const SPECS = {
  report: [{ opt: '--ms', type: 'number', default: 2000 }],
  update: [{ opt: '--ms', type: 'number', default: 3000 }, { opt: '--no-ok', type: 'flag' }, { opt: '--watch', type: 'str', repeat: true }],
  play: [{ opt: '--gui-log', type: 'int' }, { opt: '--gui-lines', type: 'int', default: 12 }, { opt: '--flash-log', type: 'flag' },
    { opt: '--card-log', type: 'int' }, { name: 'outdir', positional: true }, { name: 'steps', positional: true, rest: true }],
  crawl: [{ opt: '--depth', type: 'int', default: 4 }, { opt: '--maxlist', type: 'int', default: 140 }, { opt: '--maxshots', type: 'int', default: 4000 },
    { opt: '--budget', type: 'int', default: 150 }, { opt: '--topmax', type: 'int', default: 1000 },
    { name: 'outdir', positional: true }, { name: 'name', positional: true }, { name: 'steps', positional: true, rest: true }],
};
const cmd = argv[0];
if (!SPECS[cmd]) fail(2, `usage: ${PROG} report|update|play|crawl ... (${cmd === undefined ? 'no command' : `unknown command ${cmd}`}; the header says more)`);
let opts;
try { opts = parseArgs(`${PROG} ${cmd}`, argv.slice(1), [...COMMON, ...SPECS[cmd]]); } catch (e) {
  if (!(e instanceof UsageError)) throw e;
  process.stderr.write(`${PROG}: ${e.message}\n${e.usage ? `${e.usage}\n` : ''}`); process.exit(2);
}

const host = await importLab(PROG, new URL('../host/boot.mjs', import.meta.url).href);
const { createE101, tasks } = await importLab(PROG, new URL(BOOTS[MODEL], import.meta.url).href);
const { compose } = await import('../src/boot/e101screen.mjs');
const { KEYS, press, release } = await import('../src/boot/e101keys.mjs');
const { buildFat16, listFat } = await import('../src/boot/e101card.mjs');
const { MODELS } = await import('../src/fw/models.mjs');
const { binPin, REPO } = await import('../host/blobs.mjs');
const { R, S, PC, A1, D0, h8 } = await import('../src/boot/bootlab.mjs');

// the firmware
const pin = binPin(MODELS[MODEL]);
const binFile = opts.bin ?? (pin && path.join(REPO, pin.rel));
if (!binFile || !fs.existsSync(binFile)) fail(3, `no .BIN: give --bin FILE (or put ${pin ? pin.rel : MODELS[MODEL].bin} in place)`);
const fw = host.readBin(binFile, MODEL);
// the options of the body
const list = (s, f) => (s === undefined ? undefined : s === 'none' ? [] : s.split(',').filter(Boolean).map(f));
const stateFile = opts.state ?? null;
const cardImgFile = opts.card_img ?? null;
let card = null;
if (cardImgFile && fs.existsSync(cardImgFile)) card = new Uint8Array(fs.readFileSync(cardImgFile));
else if (opts.card) card = buildFat16(host.folderTree(opts.card)).img;
else if (cardImgFile) fail(2, `--card-img ${cardImgFile}: no such file (build one with --card DIR first, or give --card too)`);
const bodyOpts = {
  rom: fw.rom, blocks: fw.blocks, flashState: stateFile ? host.readState(stateFile) : null, card,
  rtc: opts.rtc !== undefined ? host.rtcSeconds(opts.rtc) : null, fast: !!opts.fast, cam: !!opts.cam, img: !!opts.img,
  flashWrites: !opts.no_flash_write, tilt: opts.tilt ? opts.tilt.split(',').map(Number) : null,
  ...(opts.card_detect !== undefined ? { cardDetect: opts.card_detect } : {}),
  ...(opts.take_fake !== undefined ? { takeFake: list(opts.take_fake, (x) => parseInt(x, 16)) } : {}),
  ...(opts.api_fake !== undefined ? { apiFake: list(opts.api_fake, (x) => x) } : {}),
};
const e = createE101(bodyOpts);
const labMs = () => e.labMs();
const CON = (s) => s.split('\n').filter((l) => !/TAG_NOT_EXIST|^ 0000/.test(l));

if (cmd === 'report') {
  const t0 = Date.now();
  const r = e.run({ maxLabMs: opts.ms, maxMs: 300000 });
  const con = CON(e.console);
  process.stderr.write(`image: ${path.basename(binFile)} ${fw.stock ? '(stock)' : `(main block ${fw.sha256.slice(0, 16)}, not stock)`}\n`);   // stderr: the report's lines are the run's alone
  console.log('stop:', JSON.stringify(r), '| lab ms', labMs().toFixed(1), '| wall ms', Date.now() - t0, '| insns cpu0', S.insns, 'cpu1', e.m.cores.state().insns);
  console.log('console (' + con.length + ' lines, prm tag messages left out):\n  ' + con.join('\n  '));
  console.log('boot marks:', e.marks.length, 'last', e.marks.slice(-3).map((m) => m[0]).join(' '));
  for (const c of [0, 1]) {
    const by = {};
    for (const t of tasks(e, c)) by[t.state] = (by[t.state] || 0) + 1;
    console.log(`cpu${c} tasks:`, JSON.stringify(by));
  }
  console.log('quick start log:', e.fastLog.join(' | '));
  console.log('application events taken:', e.evLog.length, 'last:', e.evLog.slice(-4).map((x) => `${x[1]}`).join('; '));
  console.log('camera API async calls:', e.apiLog.join(' ; '));
  console.log('file task:', e.fileLog.slice(0, 3).join(' ; '));
  console.log('firmware error log entries:', e.errLog.length, e.errLog.slice(0, 5).join(' ; '));
  console.log('stand-ins and observers hit:', [...e.hooks.values()].filter((h) => h.count).map((h) => `${h.name} x${h.count}`).join(', '));
  console.log('I2C transfers', e.i2cLog.length, '| SIO client transfers', e.sioLog.length, '| BC transactions', e.bcLog.length, '| SD commands', e.sdLog.length, '| DMA', e.dmaLog.length, '| S-DIV0', e.div0, '| refused MMIO', e.denied.length);
  const c1 = e.m.cores.state();
  console.log('cpu1:', c1.parked ? 'PARKED ' + c1.parked : (c1.halted ? 'idle' : 'running'), '| problems:', e.m.cores.problem()?.message ?? 'none');
  const ok = r.why === 'labtime' && !c1.parked && /Usr4/.test(e.console) && e.console.includes(':-)');
  console.log(ok ? 'STAGE 2: PASS (kernel on both cores, Usr0..Usr4 done, tasks scheduled, no fault)' : 'STAGE 2: FAIL');
  process.exit(ok ? 0 : 1);
}

if (cmd === 'update') {
  if (!opts.no_ok) e.pins.set(0x35, 0);
  const W = { '7e5056ab': 'update flag byte cleared (OK held)', '7e504629': 'boot task takes the UPDATE branch', '7e504631': 'boot task takes the NORMAL branch',
    '7e504c18': 'segment-2 load call', '7e54350e': 'FIRMUP_CLI task body', '7e5435bd': 'firmup: binary file found', '7e5436c2': 'firmup: Are?', '7e54398b': 'FIRMUP_SRV task body' };
  for (const w of opts.watch) { const [p, ...n] = w.split(':'); W[p.toLowerCase().replace(/^0x/, '')] = n.join(':') || 'watched pc'; }
  const seen = {};
  for (const [p, n] of Object.entries(W)) e.hook(parseInt(p, 16), 'w' + p, () => { if (!seen[p]) console.log(`t=${labMs().toFixed(3)} ms first reach ${p}: ${n}`); seen[p] = (seen[p] || 0) + 1; });
  const r = e.run({ maxLabMs: opts.ms, maxMs: 600000 });
  console.log('stop:', JSON.stringify(r), 'lab ms', labMs().toFixed(1));
  console.log('console:\n  ' + CON(e.console).join('\n  '));
  console.log('counts', JSON.stringify(seen));
  for (const c of [0, 1]) { const by = {}; for (const t of tasks(e, c)) by[t.state] = (by[t.state] || 0) + 1; console.log(`cpu${c} tasks`, JSON.stringify(by)); }
  console.log('errors', e.errLog.length, e.errLog.slice(0, 4).join(' ; '));
  if (e.card) console.log(`card: ${e.card.reads} blocks read, ${e.card.writes} written`);
  console.log('problems:', e.m.cores.problem()?.message ?? 'none');
  process.exit(0);
}

const saveAll = () => {
  if (stateFile) { host.writeState(stateFile, e.flashStateDoc()); console.log('state saved to', stateFile); }
  if (e.card && cardImgFile && e.card.dirty) fs.writeFileSync(cardImgFile, e.card.img);
};
const out = opts.outdir;
fs.mkdirSync(out, { recursive: true });

if (cmd === 'play') {
  const glog = [];
  if (opts.gui_log) {
    e.hook(0x7ECE6333, 'guilogv', () => { const s = e.cstr(R[A1] >>> 0, 60); if (/RCV_EV|key_event|keyID|state = /.test(s)) glog.push(`${labMs().toFixed(0)} ${s} ${h8(R[D0])}`); });
    e.hook(0x7ECE631E, 'guilog', () => { const s = e.cstr(R[A1] >>> 0, 60); if (opts.gui_log === 2 && !/getSetting|TouchPanel|EXCLUSIVE|waitEvent|isBackLight|NormalProc|updateResearch|getKeyState|getMedia|getExistMedia/.test(s)) glog.push(`${labMs().toFixed(0)} ${s}`); });
  }
  const run = (ms) => { const r = e.run({ maxLabMs: ms, maxMs: 600000 }); if (r.why !== 'labtime') { console.log('STOP', JSON.stringify(r)); process.exit(2); } };
  run(opts.boot_ms);
  for (const step of opts.steps) {
    const f = step.split(':');
    if (f[0] === 'w') { if (!(Number(f[1]) > 0)) { console.log('bad step', step); process.exit(2); } run(Number(f[1])); }
    else if (f[0] === 'pin') e.pins.set(parseInt(f[1], 16), Number(f[2]));
    else if (f[0] === 'adc') { if (f[1] === '*') e.adc.fill(Number(f[2])); else e.adc[Number(f[1])] = Number(f[2]); }
    else if (f[0] === 'tilt') e.tilt = f[1] === 'off' ? null : [Number(f[1]), Number(f[2]), Number(f[3])];
    else if (f[0] === 'port') e.setPorts(parseInt(f[1], 16));
    else if (f[0] === 'key') { if (!KEYS[f[1]]) { console.log('unknown key', f[1]); process.exit(2); } press(e, f[1]); run(Number(f[2] || 120)); release(e, f[1]); run(400); }
    else if (f[0] === 'shot') { const file = path.join(out, f[1] + '.png'); host.writePng(file, compose(e)); console.log('shot', file, 'osd runs', e.osd.runs, e.videoRom != null ? 'rom picture 0x' + e.videoRom.toString(16) : ''); }
    else { console.log('unknown step', step); process.exit(2); }
    if (glog.length) console.log(`[${step}] ` + glog.splice(0).slice(-opts.gui_lines).join(' | '));
  }
  if (e.flashLog.length && opts.flash_log) console.log(e.flashLog.join('\n'));
  saveAll();
  if (e.card) {
    console.log(`card: ${e.card.reads} blocks read, ${e.card.writes} written; unknown commands ${[...e.card.unknown].join(' ') || 'none'}`);
    if (opts.card_log) console.log(e.card.log.slice(0, opts.card_log).join('\n'));
    if (e.card.dirty) console.log('card files now:', listFat(e.card.img).map((x) => `${x.path} (${x.size})`).join(', '));
  }
  if (e.osd.log.length) console.log('osd notes:', e.osd.log.slice(0, 6));
  if (e.denied.length) console.log('refused MMIO:', e.denied.slice(0, 8).map(([d, a, w, pc]) => `${d} ${h8(a)}/${w} pc ${h8(pc)}`).join(', '));
  console.log('done at lab ms', labMs().toFixed(0), '| errors', e.errLog.slice(-3).join(' ; '));
  process.exit(0);
}

// crawl: from the screen the steps reach, at each cursor position write OUTDIR/NAME.<i>.png, press RIGHT (a changed
// screen is a child: walked the same way, then left with LEFT or MENU), then DOWN, until the screen repeats (a wrap) or
// does not change. A screen is the composed frame: its identity is the hash of its pixels. OK is never pressed. Writes
// OUTDIR/NAME.log.json: [{name, hash, rom, err, note}]. --state is read, never written back
{
  const NAME = opts.name, DEPTH = opts.depth, MAXLIST = opts.maxlist, MAXSHOTS = opts.maxshots, BUDGET = opts.budget, TOPMAX = opts.topmax;
  const log = []; let shots = 0, keys = 0, frame = null, errSeen = 0, budgetLeft = BUDGET;
  const finish = (code) => {
    fs.writeFileSync(path.join(out, NAME + '.log.json'), JSON.stringify(log, null, 0).replace(/\},\{/g, '},\n{'));
    console.log(`${NAME}: ${shots} screens, ${keys} keys, lab ms ${labMs().toFixed(0)}, firmware errors ${e.errLog.length}, notes ${log.filter((l) => l.note).map((l) => l.name + ':' + l.note).join(' | ').slice(0, 300)}`);
    process.exit(code);
  };
  const run = (ms) => { const r = e.run({ maxLabMs: ms, maxMs: 3600000 }); if (r.why !== 'labtime') { log.push({ name: 'STOP', note: JSON.stringify(r) }); finish(2); } };
  const hash = () => { frame = compose(e); return crypto.createHash('sha1').update(frame.rgb).digest('hex').slice(0, 16); };
  // the frame the same in two looks 100 ms apart (at least 300 ms, at most 2500 ms)
  const settle = () => { run(200); let h = hash(); for (let t = 200; t < 2500; t += 100) { run(100); const h2 = hash(); if (h2 === h && t >= 300) return h; h = h2; } return h; };
  const key = (k) => { keys++; press(e, k); run(120); release(e, k); return settle(); };
  const save = (name, h, note) => {
    if (++shots > MAXSHOTS) { log.push({ name: 'LIMIT', note: 'MAXSHOTS' }); finish(3); }
    host.writePng(path.join(out, name + '.png'), frame);
    const err = e.errLog.slice(errSeen); errSeen = e.errLog.length;
    log.push({ name, hash: h, rom: e.videoRom ?? null, ...(err.length ? { err } : {}), ...(note ? { note } : {}) });
  };
  class Desync extends Error {}
  class Budget extends Error {}
  class LeftTo extends Error { constructor(h) { super('left'); this.h = h; } }
  const p2 = (i) => String(i).padStart(2, '0');
  // leave a child screen: LEFT first (in a multi-field editor it moves back one field; in a list it goes back one
  // level), then MENU; a screen that is then an ancestor's throws LeftTo, and the frame that owns it goes on from there
  const back = (here, name, stack) => {
    let h = key('LEFT'); if (h === here) return;
    h = key('MENU'); if (h === here) return;
    if (stack.includes(h)) { log.push({ name, note: 'leaving this screen went up more than one level' }); throw new LeftTo(h); }
    h = key('MENU'); if (h === here) { log.push({ name, note: 'back needed a second MENU' }); return; }
    if (stack.includes(h)) { log.push({ name, note: 'leaving this screen went up more than one level' }); throw new LeftTo(h); }
    log.push({ name, note: 'DESYNC: cannot get back' }); throw new Desync();
  };
  const explore = (name, depth, stack) => {
    let here = hash(); const first = here; const seen = new Map([[here, 0]]);
    for (let i = 0; i < MAXLIST; i++) {
      const nm = `${name}.${p2(i)}`;
      if (depth === 0) budgetLeft = BUDGET; else if (--budgetLeft < 0) { log.push({ name: nm, note: 'BUDGET: the rest of this row\'s sub-screens was not walked' }); throw new Budget(); }
      save(nm, here);
      if (depth < DEPTH) {
        const h2 = key('RIGHT');
        if (h2 !== here) {
          if (seen.has(h2) || stack.includes(h2)) {
            log[log.length - 1].note = seen.has(h2) ? 'RIGHT moves inside the screen' : 'RIGHT goes to an ancestor';
            const h3 = key('LEFT'); if (h3 !== here) { if (stack.includes(h3) || stack.includes(h2)) throw new LeftTo(stack.includes(h3) ? h3 : h2); log.push({ name: nm, note: 'DESYNC after RIGHT/LEFT' }); throw new Desync(); }
          } else {
            try { explore(nm, depth + 1, [...stack, ...seen.keys()]); back(here, nm, stack); }
            catch (x) {
              if (x instanceof Budget && depth === 0) { let h = hash(); for (let k = 0; k < 8 && h !== here; k++) h = key('MENU'); if (h !== here) { log.push({ name: nm, note: 'DESYNC after BUDGET' }); throw new Desync(); } }
              else if (!(x instanceof LeftTo) || x.h !== here) throw x;
              else log.push({ name: nm, note: 'continued here after the child left more than one level' });
            }
          }
        }
      }
      const h4 = key('DOWN');
      if (h4 === here) { log.push({ name: nm, note: 'DOWN does nothing (end of list)' }); break; }
      if (seen.has(h4)) { if (seen.get(h4) !== 0) log.push({ name: nm, note: 'DOWN wraps to position ' + seen.get(h4) }); here = h4; break; }
      if (stack.includes(h4)) { log.push({ name: nm, note: 'DOWN leaves to an ancestor' }); throw new LeftTo(h4); }
      seen.set(h4, i + 1); here = h4;
      if (depth === 0 && i + 1 >= TOPMAX) { log.push({ name: nm, note: 'TOPMAX: this unit ends here (the next unit continues)' }); break; }
      if (i === MAXLIST - 2) log.push({ name, note: 'MAXLIST reached' });
    }
    // back to the first position, so that the parent finds its screen unchanged
    for (let k = 0; here !== first && k < MAXLIST; k++) { const h = key('UP'); if (h === here) break; here = h; }
  };
  run(opts.boot_ms);
  for (const step of opts.steps) {
    const f = step.split(':');
    if (f[0] === 'w') run(Number(f[1]));
    else if (f[0] === 'key') key(f[1]);
    else if (f[0] === 'port') e.setPorts(parseInt(f[1], 16));
    else if (f[0] === 'pin') e.pins.set(parseInt(f[1], 16), Number(f[2]));
    else if (f[0] === 'tilt') e.tilt = f[1] === 'off' ? null : [Number(f[1]), Number(f[2]), Number(f[3])];
    else if (f[0] === 'shot') { const h = hash(); save(`${NAME}-entry-${f[1]}`, h); }
    else { console.log('unknown step', step); process.exit(2); }
  }
  errSeen = 0;
  try { explore(NAME, 0, []); } catch (x) { if (!(x instanceof Desync) && !(x instanceof LeftTo) && !(x instanceof Budget)) throw x; log.push({ name: NAME, note: 'UNIT ENDED EARLY' }); }
  finish(0);
}
