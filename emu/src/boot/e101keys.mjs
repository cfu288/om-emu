// The E-PM2's keys as its body presents them to UI_IN (docs/e101-boot-spec.md section 6). A key is one of
//   {pin: n}         a GIO input pin (S-GIOIN's lab.pins), pressed = level 0;
//   {adc: [ch, v]}   the key ladder's ADC value on input ch, with the key-on line's handler posted;
//   {port: k}        the system controller's port k (src/boot/e101dev.mjs systemController), toggled.
// The GIO pins are UI_IN's group 7, polled every 10 ms at 0x7e50c5f2 (D); a name is X where the GUI's own log or
// reaction named it, I otherwise.
export const KEYS = {
  OK: { pin: 0x35 },          // GUI event 0x01000016 / 17: opens the Live Guide in iAUTO (X)
  PLAY: { pin: 0x28 },        // 0x0100001e / 1f: playback (X)
  ERASE: { pin: 0x41 },       // 0x01000026 / 27: the handler "deleteMultiExposure" (I: the erase key)
  CUSTOM1: { pin: 0x32 },     // key 0x1209, 0x01000022 / 23: a customisable key (checkFuncDirectStart): Fn or the movie button, which is ?
  CUSTOM2: { pin: 0x42 },     // key 0x0b, 0x0100002e / 2f: the other customisable key (checkFuncDirectStart, isMediaAccess)
  // the key ladder on ADC input 3 (UI_IN group 6; thresholds 0x22, 0x64, 0xa8, 0xef, 0x139, 0x18f, 0x1f2, 0x2c2, D)
  MAGNIFY: { adc: [3, 0x43] }, // key 0x0a, 0x01000042 / 43: pressLvMagnifyKey (the zoom frame, then 10x) (X: the GUI's log)
  UP: { adc: [3, 0x86] },     // key 5, 0x01000006 / 07: an arrow
  DOWN: { adc: [3, 0xCB] },   // key 6, 0x0100000a / 0b: an arrow
  LEFT: { adc: [3, 0x114] },  // key 7, 0x0100000e / 0f: the AF target grid (I: the left arrow)
  RIGHT: { adc: [3, 0x164] }, // key 8, 0x01000012 / 13: an arrow
  INFO: { adc: [3, 0x1C0] },  // key 0x1205, 0x0100002a / 2b: pressInfoKey, the INFO button (X: the GUI's log and the display cycle)
  MENU: { adc: [3, 0x250] },  // key 0x89, 0x0100001a / 1b: MENU (X: the sub-app ShootingMenu, state 0x5700)
  POWER: { port: 0 },         // the ON/OFF button: the power-off sequence (the settings banks saved to flash)
  S1: { pin: 0x72 }, S2: { pin: 0x74 },   // the shutter's half and full press (UI_IN group 2, keys 0x100 / 0x101)
  // tries that gave no GUI event: an I/O expander sample, an emitted key
  X12: { ioe: [9, [0x00, 0x10]] }, E0B: { emit: [0x0B, 12] },
};
export const ADC_IDLE = 0x3FF;
// A ladder key: input 3 takes the key's value and the key-on line (GIO pin 0x5d, an edge interrupt UI_IN registers at
// 0x7e50b40b, D) fires: its handler 0x7e50b50d(a0 = the ladder's table entry 0x7e7354cc) starts the ADC scan, which
// then repeats every 10 ms until the value says "no key". S-KEYON: the handler is posted directly (the GIO pin
// interrupt unit is not modelled)
export function press(e, name) {
  const k = KEYS[name];
  if (k.pin !== undefined) e.pins.set(k.pin, 0);
  if (k.adc) { e.adc[k.adc[0]] = k.adc[1]; e.post(0x7E50B50D, 0x7E7354CC, 0); }
  if (k.port !== undefined) e.setPorts(e.ports ^ (1 << k.port));
}
export function release(e, name) {
  const k = KEYS[name];
  if (k.pin !== undefined) e.pins.set(k.pin, 1);
  if (k.adc) e.adc[k.adc[0]] = ADC_IDLE;
  if (k.port !== undefined) e.setPorts(e.ports ^ (1 << k.port));
  if (k.ioe) pushSample(e, k.ioe[0], k.ioe[1].map(() => 0));
  if (k.emit) emitKey(e, k.emit[0], k.emit[1], true);
}
// UI_IN sample injection for the groups whose source is not modelled (the I/O expanders on I2C): the sample bytes are
// pushed as the group's own completion would, 0x7e50aa1c(d0 = length, d1 = group, a0 = bytes), from interrupt context
// through a pad in lab low RAM (`mov group,d1; call 0x7e50aa1c,[],4; rets`)
let padN = 0;
export function pushSample(e, group, bytes) {
  const pad = 0x00011100 + 16 * (group & 15), data = 0x00011400 + 8 * (padN++ & 31), d = (0x7E50AA1C - (pad + 2)) | 0;
  e.wr(pad, [0x85, group, 0xDD, d & 255, (d >>> 8) & 255, (d >>> 16) & 255, (d >>> 24) & 255, 0x00, 0x04, 0xF0, 0xFC]);
  e.wr(data, bytes);
  e.post(pad, data, bytes.length);
}
// UI_IN event injection: the emitter 0x7e50a7ac(d0 = type << 24 | released << 16 | key id, d1 = its index in its
// group), from interrupt context through a pad (`mov event,d0; mov index,d1; call 0x7e50a7ac,[d2,d3,a2,a3],20;
// rets`), for keys whose electrical source is not identified (KEYS entries with emit)
let emitN = 0;
export function emitKey(e, key, index, released) {
  const pad = 0x00011800 + 32 * (emitN++ & 15), ev = (0x02000000 | (released ? 0x10000 : 0) | key) >>> 0, d = (0x7E50A7AC - (pad + 8)) | 0;
  e.wr(pad, [0xFC, 0xCC, ev & 255, (ev >>> 8) & 255, (ev >>> 16) & 255, (ev >>> 24) & 255, 0x85, index, 0xDD, d & 255, (d >>> 8) & 255, (d >>> 16) & 255, (d >>> 24) & 255, 0xF0, 0x14, 0xF0, 0xFC]);
  e.post(pad, 0, 0);
}
