> Status (2026-11-16): the E-PM2's (E101 v1.6) firmware boots from its reset vector in the boot lab on both cores, to
> the camera application, its menus, playback, the card and the update path (X: section 7). Not modelled: live view,
> the picture, capture, the mechanism, timing. The boot lab is `emu/src/boot/`; its tool `emu/bin/boot.mjs`.

# E-PM2 (E101): the firmware from its reset vector

Firmware = E101 v1.6, `OLY_E_101_1600_0000_0000.BIN` (BLOBS.sha256), the main block run at `0x7e421020`. Addresses are
run-time addresses of that build (the disassembly notation is not used here: block offset + `0x7e421020`). Tags as in
[README.md](README.md): X executed in the boot lab (the command is named), D read from the firmware, I inference, ?
unknown. Labels: S-* stand-ins, H-* harness steps, A-* assumptions.

## 1. Why a boot lab

The survey puts E101 in tier D (`docs/model-survey.md`, `docs/ROADMAP.md` "Multi-model"): its build pairs 0.30M
instructions with E143's and leaves 216 of the lab's addresses unplaced, so the HLE lab, whose every address is
E143's, has no port to it. The E-PM2's firmware is much smaller than E143's (a 13.5 MiB main block, two cores, no OSD
engine at `0x9c100000`), and its start runs on what om-emu already has (the MN103 core and interpreter, the
second core, the interrupt controller, the timer and the lab clock) with few devices of its own. The boot lab lets it
run from the reset vector, as `docs/ROADMAP.md` "Longer term: full-boot LLE" plans for E143: every access to a device
nothing declares faults (fault 2), and a device or a stand-in is added only where the code shows what it needs.

## 2. The boot lab (`emu/src/boot/bootlab.mjs`, `flash.mjs`)

- **Machine.** `createMachine` on E101's board (`src/fw/models.mjs` E101: the E118 family's, with its own controller
  banks, IRQ count, semaphores, timer, 512 MiB of DRAM), with the second core (`cores` option: CPU 1 is the second,
  its vector page `0x7e440000`, quantum 2000). Two RAM regions the board lacks: the on-chip SRAM `0x47000000`
  (64 KiB: the kernel configuration, the reset stack `0x47001ffc`, the SRAM code copy at `0x47001000`, D) and
  `0x28a00000` (1 MiB), which the cache purge `0x7e45da9d` reads 512 words of (D).
- **Flash.** The `.BIN`'s four OE blocks, each with its 32-byte head, at its load address: main `0x402c0000`,
  resources `0x43c40000`, `0x45220000` (flags `0x0106`), `0x45480000` (`0x0104`) (D: the heads). The OM block after
  them (load 0, 64 KiB) is the updater's and is left out (I). Every address is taken to the `0x40000000` view; where no
  block is, the flash reads `0xff` (I: erased). The flash stand-ins (section 5) read and write this view.
- **MMIO.** The window `0x80000000..0x9fffffff` that the machine's lab stub serves is the boot lab's: each 1 MiB block
  the body module declares (section 4) is a device model or plain storage (H-PLAINREG: a read returns what was last
  written, 0 before, word-granular); an access to a block nobody declared is refused with a stderr line `boot-stub
  DENIED` and a bus error, fault 2 (ARCHITECTURE.md "Unported paths throw"). `0x98e00000`, where E143's board has the
  SCPU interface model, is taken over: the E-PM2's system controller is another device there.
- **Hooks.** A pc hook at a function's entry returns through the `ret` that matches the call before MDR (its register
  list and frame from the `call` instruction; a `calls` gets a plain `rets`). A hook that leaves the pc alone is an
  observer, and the instruction under it is stepped. The second core's stops at the same pcs run the same hooks.
- **Lab time.** A-NSPERINSN: 4 ns of lab time per instruction of CPU 0, a choice, not the chip's speed; the lab clock
  moves after each slice of 20,000 instructions and at each stop. H-IDLE: at the kernels' idle loops (`0x7e436825`,
  `0x7e43683d`) and the boot task's (`0x7e44966c`), CPU 1 halts until its bank presents an interrupt; on CPU 0 lab time
  moves to the next device event (at most 50 ms), or CPU 1 runs a turn while it has work. A run with the same inputs
  gives the same report and the same PNG bytes (X: two runs of section 7's commands).
- **Reset.** pc `0x7e421020`, sp `0x47001ffc`, PSW 0. H-FAITHFULLOAD: at reset only `0x7e421020..0x7e430000` of block
  0 is in RAM, what the first-stage loader (not in the update file, ?) leaves; the firmware's own nine loader copies
  bring in the rest through S-FLASHREAD0, so a patch in a range nothing loads is absent here, as on the camera (I).

## 3. What the boot lab takes from om-emu

| Part | E101's use |
|---|---|
| `src/core/cores.mjs` option `vectorPage` | CPU 1 takes its interrupts in page `0x7e44`: its kick handler `0x7e44efea` (IRQ 124) is there (X: both kernels start); the page is the boot's run-time copy (I: block 0 holds `0xff` at `0x7e440020`) |
| `src/dev/intc.mjs` board fact `kick_cross` | a bank's kick (`+0x310` = 1) raises the other core's kick IRQ, and `+0x314` = 1 acknowledges it: CPU 0 writes `0x99200310`, CPU 1's IRQ 124 handler clears it at `0x99200314` (D); so E101's board has no `ctl` (the E118 family's K-INTC word at `+0x314`) |
| `src/dev/intc.mjs` `onMask` | H-GNICR: the GnICR request flags (`0x8940 + 4 level`, bit 4) of each core's system page follow its bank's presented mask; the kernel polls them (`0x7e43369f` waits for the other CPU's kick, D) |
| `src/fw/models.mjs` E101 | the board facts above, the VSC and OSD engine models parked on `0x9f600000` / `0x9f610000` (no E-PM2 code loads an address there, X: a census) |

Nothing else of the core changes: an undefined flag's read and a divide by 0 fault as everywhere, and the two sites the
E-PM2 reaches are stand-ins of their own (S-ROLC, S-DIV0).

## 4. Devices (`emu/src/boot/e101dev.mjs`, `e101.mjs` BLOCKS)

Register-level models (each with its evidence at the code):

| Block | Model |
|---|---|
| `0x98e00000` system controller | the command word `+0xa4` (done at once), the always-on bit `+0x00` bit 1, the wake factors `+0x48` (factor 2: the power lever, I), the five input ports `+0x58..` (port 2 the card's presence, port 3 the quick start's check) with their change bits `+0x50` and IRQ 120; S-RTC with a clock setting: the seconds counter `+0x98` in Unix time (D: the driver's own conversion `0x7e508a6f`), `+0x9c` the milliseconds, the marker 42 in `+0x00` bits 2..7 |
| `0x98c00000` ADC | the start `+0x04` done at once, three completion groups, IRQ 117, one result word per input (S-ADC: `0x200`, input 3, the key ladder, `0x3ff`, no key) |
| `0x99000000` SD host | `SD_INFO2` (`+0x203c`) bit 13, the bus-idle flag; the commands are served at the driver's seam (S-SDCMD) |
| `0x9a900000` display controller | INTEN `+0x0c`, INTST `+0x14`, the frame and line-compare bits every 16.683 ms (A-FRAME), IRQ 14; the palette bank written last (I) |
| `0x9a100000` GIO | the deferred-call triggers `+0xf4..+0x100` (IRQ 23..26), 15 one-shot timers (IRQ 17..22; S-GIOTIMER: a timer's time is its set-up's microseconds), the bit-search unit `+0x104..+0x110` (I) |
| `0x9aa00000` OSD draw engine | fill, copy, run-length bitmap and colour table, run at the start write (A-OSDTIME); scaled bitmaps drawn unscaled (A-OSDSCALE); a 0 colour transparent (A-OSDCLEAR, I) |

Plain storage (H-PLAINREG), named by the code that uses them: `0x80000000` the flash memory controller, `0x98000000`
(?), the five serial channels `0x98200000..0x98600000` (I: the E118 family's blocks), the debug console's serial port
`0x98700000` (I), the clock block `0x98800000` (I; its `+0xf0` is CPU 1's release, H-CPU1START), `0x98b00000` (?),
the boot control `0x98d00000` (`+0x140` CPU 1's entry, D), `0x99700000`, `0x99900000`, `0x99a00000`, `0x99c00000`,
`0x99d00000` (?: the camera power-up's and CAMAFD's and SPRDRV's drivers), the AE statistics unit `0x99b00000` (D:
AE_SEM), the stabiliser assist `0x9a200000` (I), the mechanism's timing unit `0x9a300000` (I), `0x9a400000`,
`0x9a600000`, `0x9ab00000` (?), the PWM unit `0x9a500000` (I), and the IMG library's per-CPU window `0x9c000000` (D).
These 24 and five of the models are the 29 blocks the runs of section 7 touch (X); the SD host's registers are not
touched without a card.

## 5. Stand-ins and harness steps (`emu/src/boot/e101.mjs`)

| Label | At | What it does | Tag |
|---|---|---|---|
| S-CONSOLE | `0x7e44b051` | the debug serial putchar: the console text kept, no UART | D the seam |
| S-OSDFILL | `0x7e4213f7`, CPU 1's `0x7e426b5d` | the reset's memory clear through the OSD engine: the range zeroed | D |
| S-FLASHREAD0 | `0x7e4217e6` | the early flash reader reads the flash view | D the seam; the areas no block holds (adjustment data, ROM pictures) read `0xff` |
| S-FLASHWRITE, S-FLASHERASE | `0x7e451b69`, `0x7e4519c5` | the settings store's writes and erases kept in the flash view and in the kept state (`flashStateDoc`, `--state`) | D the seam |
| S-BANKRESTORE | `0x7e4580bd` | A-POWEROFF: the power-off sequence does not finish, so the kept RAM images of the MODE and EEROM banks are written back when the boot-time bank save is first entered | I |
| S-DMA | `0x7e425fa8`, `0x7e426045`, `0x7e42627b` | the CPU's DMA: the copy (or the mode-2 fill) done in the start call | D the descriptor |
| H-IDLE, H-CPU2POLL | `0x7e436825`, `0x7e43683d`, `0x7e44966c`; CPU 1's `0x7e44eb5b` | lab time to the next event; CPU 1 sleeps on its request words `0x8ff0008c..0x8ff000af` | D the loops |
| H-CPU1START | the write of 1 to `0x988000f0` | CPU 1 starts at the entry in `0x98d00140` | D `0x7e4213c4..0x7e4213d9` |
| S-ROLC | `0x7e5018fc` | `rol d3` in the soft-float multiply reads C, which the `udf04` before it leaves undefined; the bit lands in bit 0, which the `lsr 24` after it drops, so C is marked defined and the rol runs | D |
| S-DIV0 | `0x7e6a3203` | `divu d0,d1` by the word at `(20,a0)`, 0 at the start (X: once per boot): with divisor 0, d1 = `0xffffffff` (A-DIV0), MDR kept, N and V set, Z clear, C undefined, the divide skipped; a divisor not 0 divides natively | the value ? (the manual leaves it undefined, `docs/mn10300-isa-spec.md` 4.6) |
| S-GIOIN, S-NOFAST | `0x7e46144e`; pin `0x35` at `0x7e5026fe` | the buttons' pins released, HDMI and video out not connected, the card detect; the quick start declined as with OK held ("ErrLeOK") | D the pins; the choice the lab's |
| S-PWM | `0x7e466435`, `0x7e466448` | the PWM requests (the backlight) return 0 | I |
| S-BC | `0x7e53e792` | the H8 body controller answers every transaction with 0 | stand-in, no H8 |
| S-SDCMD, S-CARD | `0x7e5ceabb`, `0x7e5ce3e1` | SD commands to the card model (`e101card.mjs`: SD v2, standard capacity, 64 MiB, FAT16; A-SDSC), or "no response" (`0x1405`) without a card | D the record |
| S-BATT | `0x7e53963a` | the battery class `0x100`, level 100 | stand-in (no adjustment data) |
| S-IIC, S-SIO, S-SIORAW | `0x7e463275` / `0x7e4632aa`, `0x7e469cdf`, `0x7e468324` / `0x7e4686e8` | every I2C and SIO device reads 0, completions posted; the hot shoe never answers ("no flash") | stand-ins |
| S-CAM | `0x7e628303` | the mechanism sequencer's requests answered "done"; command 7 one frame later | stand-in |
| S-TAKEAPI | `0x7e67e502` | live view's start (TAKE_FUNC 0x19) and PLAY's 80:5 and 80:1 answered "done" | stand-in |
| S-IMG | `0x7e5455bf` | the IMG engine's job wait answered "finished, result 0" | stand-in |
| S-ACC | `0x7e4585dc`, `0x7e4584a4` | with a tilt only: the accelerometer's sample | stand-in |
| S-KEYON | `0x7e50b50d` posted | a ladder key's key-on handler posted directly (the GIO pin interrupt is not modelled) | D the handler |

Observers (the pc left alone): the boot marks `0x7e426511`, the error log `0x7e426d4b`, the application's events
`0x7eba752b`, the camera API's `0x7e67e493` / `0x7e67e5bb`, FILECLBK's `0x7e5c1b5b` / `0x7e5c1b9f`, USR_FAST_APP's log
`0x7e503a6e`, api_play_Play_Rom's picture `0x7e68522d`. The deferred-call post (`lab.post`: the firmware's ring 0 at
`0x60415538`, IRQ 23) is how every stand-in delivers a completion.

## 6. Keys (`emu/src/boot/e101keys.mjs`)

| Name | Source | Tag |
|---|---|---|
| MENU, INFO, MAGNIFY, UP, DOWN, LEFT, RIGHT | the key ladder on ADC input 3, the key-on handler posted (S-KEYON) | X (the GUI's own log names MENU, INFO, MAGNIFY); the arrows I |
| OK, PLAY, ERASE | GIO pins `0x35`, `0x28`, `0x41` | X; ERASE I |
| CUSTOM1, CUSTOM2 | GIO pins `0x32`, `0x42` | Fn and the movie button, which is which ? |
| POWER | the system controller's port 0 | X: the power-off sequence starts |
| S1, S2 | GIO pins `0x72`, `0x74` | I |

## 7. Runs

All with `node emu/bin/boot.mjs` (X, 2026-11-16, the stock `.BIN`):

| Command | Result |
|---|---|
| `report` | both kernels, Usr0..Usr4, the prompt, 259 application events in 2000 ms, two error-log entries `0x2a001001` at 36 ms, no refused access, S-DIV0 once, S-ROLC 122 times |
| `update --card DIR` (DIR holds `DCOLYMP/E1019999.BIN`) | the update flag cleared, FIRMUP_SRV and FIRMUP_CLI started, the file found at 41 ms; the run goes no further than the body controller's step (S-BC) |
| `play OUTDIR key:MENU ...` with a kept state | the menus in English, the Custom Menu, INFO's screens, playback; a card mounted, listed and written |
| `crawl OUTDIR top key:MENU` | the menu tree, one PNG per cursor position |

`emu/test/test_boot.mjs` checks the start and the update path (`bin/test.mjs`) and the boot lab's units (`bin/test-pure.mjs`).
The same outputs, PNG bytes included, as the drivers this replaces (the earlier out-of-tree port of epm2-tools) on
these runs and on a patched build (X).

## 8. What to trust

Trust it for: the start (the loader copies, the static constructors, both kernels, every task, the application), the
update path up to the body controller's step, the shooting information screens, the menu system (rows, labels, lists,
help texts, grey rows), the settings kept, the card's mount, format and file writes. A patch that breaks one of these
shows as a fault, a refused access, another report, another PNG or a new error-log entry.

Do not trust it for: live view, the picture, exposure, AF, capture, movies, the mechanism, timing, caches, sensor
values. The open items:

- No live view: its start is answered (S-TAKEAPI), no frame comes; the video plane is a flat grey (A-VIDEOPLANE).
- The power-off does not finish: after POWER the application waits for an event that never comes (? which);
  S-BANKRESTORE stands in for its bank save.
- The menus' background pictures are in a flash area the update file does not hold: the top menu shows only its back
  button.
- The start's error log differs from the camera's: the camera logs eight records `0x19000c02` / `0x19000c03` from
  `0x7e426045` at every start (transfers with cached addresses; X on a camera, epm2-tools' structured-log build); S-DMA stands in for that routine, so
  none appear here, and two `0x2a001001` appear at about 36 ms instead.
- The power-on factor and the wake byte read 0; the adjustment data is absent (`0xff`).
- S1 and S2, a picture in playback, an SDHC card and FAT32 are not tried; the viewfinder's screens and the super
  control panel are not reached.
- S-DIV0's quotient is the lab's; a capture of the chip's DIVU by 0 would settle it (as for `emu/FIDELITY-NOTES.md`'s
  two other divides).
