// The flash a body boots from, as its reset code and drivers read it: the .BIN's blocks, each with its 32-byte head,
// at the flash address its head gives (src/fw/olyfw.mjs parseHead load; the E-PM2's four at 0x402c0000, 0x43c40000,
// 0x45220000 and 0x45480000, D). Pure (docs/e101-boot-spec.md section 2).
//
// Addresses: every address is taken to the 0x40000000 view (its low 30 bits | 0x40000000), so its aliases at
// 0x00000000 and 0x80000000 read the same bytes (I: the bus's high two bits as an attribute, as the DRAM's 0x6 / 0xA
// aliases are). A byte no block holds reads 0xff, as erased flash does (I). A write over a block changes it in place;
// a write elsewhere adds a segment of its own after the blocks (A-FLASHSEG: segments are not merged, so of two
// written segments that overlap, a read sees the later one's bytes).
export class FlashView {
  constructor() { this.segs = []; }
  static norm(a) { return (((a >>> 0) & 0x3FFFFFFF) | 0x40000000) >>> 0; }
  // A container's walked blocks ([{block: src/fw/olyfw.mjs walk's record, head: its 32 bytes, data: the body}]), each
  // at its load address
  static fromBlocks(blocks) {
    const f = new FlashView();
    for (const b of blocks) {
      const img = new Uint8Array(32 + b.data.length);
      img.set(b.head, 0); img.set(b.data, 32);
      f.add(b.block.load, img, b.name ?? `block at 0x${(b.block.load >>> 0).toString(16)}`);
    }
    return f;
  }
  add(addr, data, name) { const a = FlashView.norm(addr); this.segs.push({ addr: a, end: a + data.length, data, name }); }
  read(addr, len) {
    const a = FlashView.norm(addr), out = new Uint8Array(len).fill(0xFF);
    for (const s of this.segs) {
      const lo = Math.max(a, s.addr), hi = Math.min(a + len, s.end);
      if (lo < hi) out.set(s.data.subarray(lo - s.addr, hi - s.addr), lo - a);
    }
    return out;
  }
  write(addr, bytes) {
    const a = FlashView.norm(addr);
    let done = 0;
    for (const s of this.segs) {
      const lo = Math.max(a, s.addr), hi = Math.min(a + bytes.length, s.end);
      if (lo < hi) { s.data.set(bytes.subarray(lo - a, hi - a), lo - s.addr); done += hi - lo; }
    }
    if (done < bytes.length) this.add(a, bytes.slice(), 'written');
  }
}
