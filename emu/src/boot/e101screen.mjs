// The E-PM2's rear screen as its display controller (0x9a900000, src/boot/e101dev.mjs) shows it: its three OSD planes
// composed over a flat video plane into 720 x 480 RGB (A-COMPOSE). Pure: host/boot.mjs writes the PNG.
// Layers (D: the register values the firmware writes and the OSD engine's destinations):
//   +0x44 a 4-bit plane with the 8-entry palette +0x300 (frames: black, white, orange, green, blue);
//   +0x48 a 4-bit plane with the 16-entry palette +0x340 (black at several alphas: the shade behind the menus);
//   +0x4c the 8-bit OSD plane, its palette's two banks of 128 entries at +0x400 and +0x600, loaded in turn (the bank
//   written last is used, src/boot/e101dev.mjs displayController), indexed by the pixel's low 7 bits (the firmware
//   clears the plane with 0xff, entry 127, transparent; what bit 7 means is ?).
// The 4-bit planes' stride is 448 bytes, the 8-bit plane's 896; 720 x 480 are visible. A palette entry is A << 24 |
// Cr << 16 | Cb << 8 | Y, A 0..15 (I: 0x0f6bff1d is BT.601 blue, 0x0f8080fe white, 0x008080ff transparent); which
// palette is which plane's is I (the values the firmware fills each plane with). The planes from the bottom: frames
// (+0x44), shade (+0x48), OSD (+0x4c) (I; opts.order changes it). The video plane is not modelled (no live view, no
// picture): a flat colour, light grey while a ROM picture is shown (the menus' backgrounds, in a flash area the update
// file does not hold, lab.videoRom) and dark grey otherwise (A-VIDEOPLANE).
const W = 720, H = 480;
export const SCREEN = { w: W, h: H };
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
function pal(e, base, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = e.store.get(0x9A900000 + base + 4 * i) ?? 0, a = (v >>> 24) & 15, cr = ((v >>> 16) & 255) - 128, cb = ((v >>> 8) & 255) - 128, y = v & 255;
    out.push([clamp(y + 1.402 * cr), clamp(y - 0.344 * cb - 0.714 * cr), clamp(y + 1.772 * cb), a / 15]);
  }
  return out;
}
// -> {rgb (W x H x 3 bytes), w, h, stats: the pixels each plane drew}
export function compose(e, { video = e.videoRom != null ? [176, 176, 176] : [40, 40, 40], order = ['p4a', 'p4b', 'p8'] } = {}) {
  const reg = (o) => e.store.get(0x9A900000 + o) ?? 0, cpu = (a) => (((a >>> 0) & 0x3FFFFFFF) | 0x40000000) >>> 0;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[3 * i] = video[0]; rgb[3 * i + 1] = video[1]; rgb[3 * i + 2] = video[2]; }
  const planes = { p8: { addr: reg(0x4C), depth: 8, pal: pal(e, (e.vsc && e.vsc.palBank) || 0x600, 128) }, p4b: { addr: reg(0x48), depth: 4, pal: pal(e, 0x340, 16) }, p4a: { addr: reg(0x44), depth: 4, pal: pal(e, 0x300, 16) } };
  const stats = {};
  for (const name of order) {
    const p = planes[name]; if (!p || !p.addr) continue;
    const stride = p.depth === 8 ? 896 : 448, buf = e.rd(cpu(p.addr), stride * H);
    let drawn = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const idx = p.depth === 8 ? buf[y * stride + x] & 127 : (x & 1 ? buf[y * stride + (x >> 1)] >> 4 : buf[y * stride + (x >> 1)] & 15);
      const c = p.pal[idx], a = c[3]; if (a === 0) continue;
      drawn++;
      const o = 3 * (y * W + x);
      rgb[o] = rgb[o] * (1 - a) + c[0] * a; rgb[o + 1] = rgb[o + 1] * (1 - a) + c[1] * a; rgb[o + 2] = rgb[o + 2] * (1 - a) + c[2] * a;
    }
    stats[name] = drawn;
  }
  return { rgb, w: W, h: H, stats };
}
