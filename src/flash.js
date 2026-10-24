// Flashes that can trigger photosensitive seizures, after WCAG 2.3.1 ("Three Flashes or Below Threshold") and the
// way Harding-style analysers measure them; the area rule follows Ofcom's broadcast guidance (a quarter of the screen).
//
// A flash is a pair of opposing changes. More than `perSecond` flashes inside any one second, over more than `area` of
// the frame, fails. General flashes: relative luminance changing by `change` or more, the darker state under `dark`.
// Red flashes: WCAG's saturated-red measure (R - G - B) x 320 on linear RGB changing by more than `red`, with one end
// saturated red (R / (R + G + B) at least `saturated`).
//
// Frames are measured small (the long side about 192 px) in tiles of 6 x 6 px: film grain and hairlines average out.
// Two ways a second can flash:
//  - the picture turns: over `area` of the frame changes the same way at once (a strobe, a white or red flash):
//    kinds `general` and `red`. A fast move across a page of text flips tiles both ways at once and turns nothing.
//  - its tiles flash on their own: over `area` of the frame holds tiles that each flash more than `perSecond` times
//    within a second, whichever way each goes (a reversing pattern, a checkerboard inverting): kinds `pattern` (light
//    and dark) and `red-pattern`.
const FLASH = { change: 0.1, dark: 0.8, red: 20, saturated: 0.8, perSecond: 3, area: 0.25 };
const TILE = 6;
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

/**
 * A scanner fed one RGB24 frame (`w` x `h`) at a time with push(px), `fps` frames a second. result() gives the
 * flashing seconds as [{ t, frame, share, kind }] (share: the least share of the frame over the flash's turns), in
 * time order; seconds of one kind that overlap are one. `onTiles(lum, i)`, if given, sees each frame's tile luminances.
 */
function flashScanner({ w, h, fps, tile = TILE, limits = FLASH, onTiles = null }) {
  if (!(fps > 0)) throw new Error("fps must be above 0");
  const tx = Math.floor(w / tile), tiles = tx * Math.floor(h / tile), need = 2 * (limits.perSecond + 1);
  if (!tiles) throw new Error(`a ${w}x${h} frame holds no ${tile} px tile`);
  const channels = [
    { kind: "general", tiles: "pattern", step: limits.change, ok: (a, b) => Math.min(a, b) < limits.dark },
    { kind: "red", tiles: "red-pattern", step: limits.red, ok: (a, b, satA, satB) => satA || satB },
  ].map((c) => ({ ...c, ref: new Float64Array(tiles), sat: new Uint8Array(tiles), dir: new Int8Array(tiles), ext: new Float64Array(tiles * 2).fill(NaN), turns: [], last: new Int32Array(tiles * need), count: new Int32Array(tiles), busy: [] }));
  const val = [new Float64Array(tiles), new Float64Array(tiles)], sat = new Uint8Array(tiles), area = tile * tile;
  let i = 0;

  function push(px) {
    if (px.length < w * h * 3) throw new Error("a frame is short");
    for (let k = 0; k < tiles; k++) {
      const x0 = (k % tx) * tile, y0 = Math.floor(k / tx) * tile;
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y0 + tile; y++) for (let x = x0; x < x0 + tile; x++) { const j = (y * w + x) * 3; r += LINEAR[px[j]]; g += LINEAR[px[j + 1]]; b += LINEAR[px[j + 2]]; }
      r /= area; g /= area; b /= area;
      val[0][k] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      val[1][k] = Math.max(0, r - g - b) * 320;
      sat[k] = r + g + b > 0 && r / (r + g + b) >= limits.saturated ? 1 : 0;
    }
    if (onTiles) onTiles(val[0], i, tx);
    channels.forEach((c, ci) => {
      let up = 0, down = 0, flashing = 0, from = i;
      for (let k = 0; k < tiles; k++) {
        const l = val[ci][k];
        if (i === 0) { c.ref[k] = l; c.sat[k] = sat[k]; continue; }
        if (Math.abs(l - c.ref[k]) >= c.step && c.ok(l, c.ref[k], sat[k], c.sat[k])) {
          const d = Math.sign(l - c.ref[k]);
          if (d > 0) up++; else down++;
          // (a tile's turn counts when the phase it ends peaked where the last phase of its kind did: a pattern trading
          // two states, not a move across text or texture, whose peaks wander; its last `need` turns are kept in a ring)
          // shortcut: a reversing pattern whose light state itself flickers between levels reads as wandering and is not
          // counted; compare peaks against more than one phase back if a real video does that.
          if (d !== c.dir[k]) {
            const steady = Math.abs(c.ref[k] - c.ext[2 * k + 1]) < c.step / 2;
            c.ext[2 * k + 1] = c.ext[2 * k];
            c.ext[2 * k] = c.ref[k];
            if (!steady) c.count[k] = 0;
            c.last[k * need + (c.count[k] % need)] = i;
            c.count[k]++;
          }
          c.dir[k] = d; c.ref[k] = l; c.sat[k] = sat[k];
        } else if ((c.dir[k] > 0 && l > c.ref[k]) || (c.dir[k] < 0 && l < c.ref[k])) { c.ref[k] = l; c.sat[k] = sat[k]; }
        // (the oldest of its last `need` turns is within the second: the tile flashes more than perSecond times in it)
        const oldest = c.last[k * need + (c.count[k] % need)];
        if (c.count[k] >= need && i - oldest < fps) { flashing++; from = Math.min(from, oldest); }
      }
      if (flashing / tiles > limits.area) c.busy.push({ frame: i, from, share: flashing / tiles });
      const sign = up >= down ? 1 : -1, share = Math.max(up, down) / tiles;
      if (share <= limits.area) return;
      const last = c.turns[c.turns.length - 1];
      // (a turn spread over two frames is one: a tile changes one way once before it turns back)
      if (last && last.sign === sign) Object.assign(last, { frame: i, share: i - last.frame <= 2 ? Math.min(1, last.share + share) : share });
      else c.turns.push({ frame: i, sign, share });
    });
    i++;
  }

  function result() {
    const out = [];
    const round = (v) => Math.round(v * 100) / 100;
    const add = (frame0, share, kind) => {
      const last = out.filter((x) => x.kind === kind).pop();
      if (last && frame0 - last.frame < fps) last.share = Math.max(last.share, share);
      else out.push({ t: Math.round((frame0 / fps) * 1000) / 1000, frame: frame0, share, kind });
    };
    for (const c of channels) {
      for (let j = 0; j + need <= c.turns.length; j++) {
        const run = c.turns.slice(j, j + need);
        if (run[need - 1].frame - run[0].frame < fps) add(run[0].frame, round(Math.min(...run.map((x) => x.share))), c.kind);
      }
    }
    // (a busy frame ends a second whose tiles flash, told from the earliest of its tiles' turns, unless a turn of the
    // whole picture already flashes there)
    const turned = out.slice();
    for (const c of channels) {
      for (const b of c.busy) {
        if (turned.some((x) => x.frame <= b.frame && x.frame + fps > b.from)) continue;
        add(b.from, round(b.share), c.tiles);
      }
    }
    return out.sort((a, b) => a.frame - b.frame);
  }

  return { push, result, frames: () => i };
}

/** The analysis size for a `width` x `height` video: its long side 192 px, both sides whole tiles. */
function analysisSize(width, height, tile = TILE) {
  const s = 192 / Math.max(width, height);
  const fit = (v) => Math.max(tile, Math.round((v * s) / tile) * tile);
  return { w: fit(width), h: fit(height) };
}

module.exports = { flashScanner, analysisSize, FLASH, TILE, LINEAR };
