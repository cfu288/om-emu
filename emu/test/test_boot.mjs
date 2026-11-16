// The boot lab (src/boot/, docs/e101-boot-spec.md) on the E-PM2's board. The model is fixed when src/ is imported, so
// both parts run in a child with OM_EMU_MODEL=E101.
//   bootUnits    (no firmware) a machine on a blank image: the flash view of synthetic blocks (the 0x40000000 view of
//                its aliases, 0xff where no block is, a write in place and one outside the blocks); a declared block's
//                plain storage (a word, then a byte into it, read back) and a model's own register; a CPU store to an
//                undeclared block refused (fault 2, its stderr line, lab.denied); kick_cross: bank 0's kick raises the
//                second core's request and not core 0's, and the mask listener hears it; the FAT16 image of a
//                folder tree read back by listFat, a name that is not 8.3 refused
//   bootSession  (the E-PM2's .BIN: BLOBS.sha256's fw/old/OLY_E_101_1600_0000_0000.BIN, else $OM_FW_DIR/<its name>,
//                else SKIPPED) the stock firmware from its reset vector for 2000 ms: both kernels, the start tasks
//                Usr0..Usr4 and the shell's prompt, no fault, CPU 1 not parked, no refused MMIO access, S-DIV0 once,
//                S-ROLC taken; and the update path: OK held and a card with the .BIN as DCOLYMP/E1019999.BIN, the update
//                flag cleared (0x7e5056ab), FIRMUP_CLI started (0x7e54350e) and finding the file (0x7e5435bd), and segment
//                2 not loaded (0x7e504c18, the normal start's load call)
//   node emu/test/test_boot.mjs          (the child: OM_EMU_MODEL=E101 node emu/test/test_boot.mjs --child [--session])
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SELF = new URL(import.meta.url).pathname;
const child = (args) => {
  const r = spawnSync(process.execPath, [SELF, '--child', ...args], { env: { ...process.env, OM_EMU_MODEL: 'E101' }, encoding: 'utf8', maxBuffer: 1 << 26 });
  const last = r.stdout.trim().split('\n').pop() ?? '';
  let res = null;
  try { res = JSON.parse(last); } catch { /* reported below */ }
  if (r.status === 0 && Number.isInteger(res?.checks)) return { checks: res.checks, bad: res.bad, skipped: res.skipped ?? [] };
  return { checks: 1, bad: [`the E101 child exited ${r.status}: ${(r.stdout + r.stderr).trim().slice(-800)}`], skipped: [] };
};
export function bootUnits() { return child([]); }
export function bootSession() { return child(['--session']); }

const IMM = (v) => [0xFC, 0xCC, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];          // mov imm32,d0
const ST = (a) => [0xFC, 0x81, a & 0xff, (a >>> 8) & 0xff, (a >>> 16) & 0xff, a >>> 24];            // mov d0,(abs32)
const STB = (a) => [0xFC, 0x82, a & 0xff, (a >>> 8) & 0xff, (a >>> 16) & 0xff, a >>> 24];           // movbu d0,(abs32)

async function units() {
  const bad = [];
  let checks = 0;
  const ok = (cond, what) => { checks++; if (!cond) bad.push(what); };
  const { FlashView } = await import('../src/boot/flash.mjs');
  const { BootLab } = await import('../src/boot/bootlab.mjs');
  const { buildFat16, listFat } = await import('../src/boot/e101card.mjs');
  // the flash view
  const head = new Uint8Array(32).fill(0x11), body = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const f = FlashView.fromBlocks([{ block: { load: 0x402C0000 }, head, data: body }]);
  ok(f.read(0x402C0020, 4).join() === '1,2,3,4' && f.read(0x802C0020, 4).join() === '1,2,3,4' && f.read(0x002C0020, 2).join() === '1,2', 'the flash: a block\'s body at load + 32, in each alias');
  ok(f.read(0x402C001E, 4).join() === '17,17,1,2' && f.read(0x402C0026, 4).join() === '7,8,255,255', 'the flash: the head before the body, 0xff after the block');
  f.write(0x802C0022, Uint8Array.from([9, 9])); f.write(0x40400000, Uint8Array.from([5]));
  ok(f.read(0x402C0020, 4).join() === '1,2,9,9' && f.read(0x40400000, 2).join() === '5,255' && f.segs.length === 2, `the flash: a write in place and one outside the blocks (${f.segs.length} segments)`);
  // a boot lab on a blank image: a program in DRAM that stores into a declared block, a model's register, bank 0's kick
  // and an undeclared block
  const lab = new BootLab({ rom: new Uint8Array(0x1000), blocks: [{ block: { load: 0x402C0000 }, head, data: body }], cores: { second: 1, quantum: 1000, vectorPage: 0x7E440000 } });
  let modelWrites = 0;
  lab.block(0x98200000, 'a plain block');
  lab.block(0x98C00000, 'a model', { read: (a) => (a === 0x98C00004 ? 0x5A : undefined), write: (a) => { if (a === 0x98C00004) { modelWrites++; return true; } return false; } });
  const masks = [];
  lab.m.devices.intc.onMask = (core, mask) => masks.push([core, mask]);
  const P = 0x61000000, prog = [...IMM(0x12345678), ...ST(0x98200010), ...IMM(0xAB), ...STB(0x98200011), ...ST(0x98C00004),
    ...IMM(2), ...ST(0x993001F0), ...IMM(1), ...ST(0x99200310), ...ST(0x9F000000)];
  lab.wr(P, prog);
  const regs = lab.m.getRegs(); regs[9] = P; regs[10] = 0; regs[15] = 0; lab.m.setRegs(regs);
  const step = (n) => { for (let i = 0; i < n; i++) lab.m.step(); return lab.m.lastStop(); };
  step(5);
  ok(lab.mmioRead(0x98200010, 4, true) === 0x1234AB78, `plain storage: a word, then a byte into it: 0x${lab.mmioRead(0x98200010, 4, true).toString(16)}`);
  ok(modelWrites === 1 && lab.mmioRead(0x98C00004, 4, true) === 0x5A && !lab.store.has(0x98C00004), 'a model\'s register: its write taken, its read the model\'s, nothing stored');
  step(4);
  const st = lab.m.cores.state();
  ok(st.irqReq === true && lab.m.devices.intc.presentedMask === 0, `kick_cross: bank 0's kick: the second core's request ${st.irqReq}, core 0's mask ${lab.m.devices.intc.presentedMask}`);
  ok(masks.some(([c, m]) => c === 1 && m !== 0), `the mask listener: ${JSON.stringify(masks.slice(-3))}`);
  const s2 = step(1);
  ok(s2.kind === 'fault' && s2.code === 2 && lab.denied.length === 1 && lab.denied[0][1] === 0x9F000000 && /boot-stub DENIED write 0x9f000000/.test(lab.stderrTail(400)),
    `an undeclared block: ${JSON.stringify(s2)}, denied ${JSON.stringify(lab.denied)}`);
  let twice = null;
  try { lab.block(0x98200000, 'again'); } catch (e) { twice = e.message; }
  ok(twice !== null && /a plain block/.test(twice), `a block declared twice: ${twice}`);
  // the card's image
  const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const { img, files } = buildFat16({ entries: [{ name: 'README.TXT', data: enc('hello') }, { name: 'DCOLYMP', dir: { entries: [{ name: 'E1019999.BIN', data: new Uint8Array(9000).fill(7) }] } }] });
  const list = listFat(img);
  ok(files.join('|') === '/README.TXT 5|/DCOLYMP/E1019999.BIN 9000' && list.length === 2 && String.fromCharCode(...list[0].data()) === 'hello' && list[1].data().every((b) => b === 7) && list[1].size === 9000,
    `FAT16: ${files.join('|')}; read back ${list.map((x) => `${x.path} ${x.size}`).join('|')}`);
  let refused = null;
  try { buildFat16({ entries: [{ name: 'TOO-LONG-NAME.TXT', data: enc('x') }] }); } catch (e) { refused = e.message; }
  ok(refused !== null && /8\.3/.test(refused), `a name that is not 8.3: ${refused}`);
  return { checks, bad };
}

async function session() {
  const bad = [], skipped = [];
  let checks = 0;
  const ok = (cond, what) => { checks++; if (!cond) bad.push(what); };
  const { MODELS } = await import('../src/fw/models.mjs');
  const { binPin, REPO } = await import('../host/blobs.mjs');
  const pin = binPin(MODELS.E101), name = MODELS.E101.bin;
  const file = [pin && path.join(REPO, pin.rel), process.env.OM_FW_DIR && path.join(process.env.OM_FW_DIR, name)].find((p) => p && fs.existsSync(p));
  if (!file) return { checks: 0, bad, skipped: [`no ${name} (${pin?.rel} or $OM_FW_DIR)`] };
  const host = await import('../host/boot.mjs');
  const { createE101, tasks } = await import('../src/boot/e101.mjs');
  const { buildFat16 } = await import('../src/boot/e101card.mjs');
  const fw = host.readBin(file);
  ok(fw.stock, `${file} is not the stock main block (${fw.sha256})`);
  {
    const e = createE101({ rom: fw.rom, blocks: fw.blocks });
    const r = e.run({ maxLabMs: 2000, maxMs: 300000 });
    const c1 = e.m.cores.state(), hits = (n) => [...e.hooks.values()].filter((h) => h.name === n).reduce((s, h) => s + h.count, 0);
    ok(r.why === 'labtime', `the start stopped: ${JSON.stringify(r)} ${e.stderrTail(400)}`);
    ok(/Usr4/.test(e.console) && e.console.includes(':-)'), `the start tasks and the prompt: ${e.console.slice(-300)}`);
    ok(!c1.parked && tasks(e, 0).length > 50 && tasks(e, 1).length > 5, `both kernels: CPU 1 ${c1.parked ?? 'running'}, tasks ${tasks(e, 0).length} and ${tasks(e, 1).length}`);
    ok(e.denied.length === 0, `refused MMIO: ${JSON.stringify(e.denied.slice(0, 4))}`);
    ok(e.div0 === 1 && hits('S-ROLC') > 0, `S-DIV0 ${e.div0} (1 wanted), S-ROLC ${hits('S-ROLC')}`);
  }
  {
    const card = buildFat16({ entries: [{ name: 'DCOLYMP', dir: { entries: [{ name: 'E1019999.BIN', data: new Uint8Array(fs.readFileSync(file)) }] } }] }).img;
    const e = createE101({ rom: fw.rom, blocks: fw.blocks, card });
    e.pins.set(0x35, 0);
    const seen = {};
    for (const [pc, what] of [[0x7E5056AB, 'flag'], [0x7E54350E, 'firmup'], [0x7E5435BD, 'found'], [0x7E504C18, 'segment2']]) e.hook(pc, what, () => { seen[what] = (seen[what] ?? 0) + 1; });
    const r = e.run({ maxLabMs: 3000, maxMs: 600000 });
    ok(r.why === 'labtime' && seen.flag > 0 && seen.firmup > 0 && seen.found > 0 && !seen.segment2, `the update path: ${JSON.stringify(r)}, reached ${JSON.stringify(seen)}`);
  }
  return { checks, bad, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--child')) {
    const r = process.argv.includes('--session') ? await session() : await units();
    console.log(JSON.stringify(r));
  } else {
    let bad = 0;
    for (const [what, r] of [['units', bootUnits()], ['session', bootSession()]]) {
      console.log(`the boot lab's ${what}: ${r.checks - r.bad.length}/${r.checks}${r.skipped.length ? `, ${r.skipped.length} SKIPPED` : ''}`);
      [...r.bad, ...r.skipped.map((x) => `SKIPPED ${x}`)].forEach((x) => console.log('  ', x));
      bad += r.bad.length;
    }
    process.exit(bad ? 1 : 0);
  }
}
