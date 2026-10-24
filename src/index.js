const path = require("path");
const { flashScanner, analysisSize, TILE } = require("./flash");
const { probe, frames, loudness } = require("./media");
const { readSubtitles, readingIssues, contrastIssues, RULES } = require("./captions");

/** Integrated loudness targets, LUFS: what each platform normalises to, or the broadcast standard. */
const TARGETS = { streaming: -14, youtube: -14, spotify: -14, tiktok: -14, instagram: -14, apple: -16, podcast: -16, ebu: -23, atsc: -24 };
const LOUD = { tolerance: 2, maxTruePeak: -1, jump: 15, over: 6 };
// Where captions sit: the lower band of the frame, inside the side margins.
const BAND = { x0: 0.15, x1: 0.85, y0: 0.7, y1: 0.92 };

function targetOf(t = "streaming") {
  if (Number.isFinite(Number(t)) && String(t).trim() !== "") return Number(t);
  if (!(t in TARGETS)) throw new Error(`--loudness takes a LUFS number or one of ${Object.keys(TARGETS).join(", ")}`);
  return TARGETS[t];
}

/** Startling jumps: momentary loudness up `LOUD.jump` LU or more within a second, ending `LOUD.over` LU above the programme. */
function jumps(momentary, integrated) {
  const out = [];
  for (let i = 0; i < momentary.length; i++) {
    const [t, m] = momentary[i];
    if (m < integrated + LOUD.over) continue;
    let low = Infinity;
    for (let j = i - 1; j >= 0 && t - momentary[j][0] <= 1; j--) low = Math.min(low, momentary[j][1]);
    if (m - low < LOUD.jump) continue;
    const last = out[out.length - 1];
    if (last && t - last.t < 2) { if (m > last.loudness) Object.assign(last, { loudness: m, rise: Math.round((m - low) * 10) / 10 }); continue; }
    out.push({ t: Math.round(t * 10) / 10, loudness: m, rise: Math.round((m - low) * 10) / 10 });
  }
  return out;
}

/** Flashing seconds of one kind that run on (each starts within a second of the last one's end) as one stretch. */
function stretches(flashes) {
  const out = [];
  for (const f of flashes) {
    const last = out.filter((x) => x.kind === f.kind).pop();
    if (last && f.t <= last.end + 0.05) Object.assign(last, { end: f.t + 1, share: Math.max(last.share, f.share) });
    else out.push({ kind: f.kind, t: f.t, end: f.t + 1, share: f.share });
  }
  return out;
}

/**
 * Checks one video: { file, duration, width, height, fps, flashes, loudness, captions, brightness, issues, verdict }.
 * `subtitles`: a subtitle file to check for reading speed and contrast; `captionColor`: its text colour;
 * `target`: the loudness target (a name in TARGETS or LUFS). Verdict: "fail" when anything flashes, else "warn" when
 * anything else is off, else "pass".
 */
async function checkVideo(file, { subtitles = null, captionColor = "#ffffff", target = "streaming", maxFps = 60 } = {}) {
  const lufs = targetOf(target);
  const info = probe(file);
  // (the source's own rate, capped: a 60 fps strobe measured at 30 would alias into something calmer)
  const fps = Math.min(maxFps, Math.round(info.fps) || 30);
  const { w, h } = analysisSize(info.width, info.height);
  const tx0 = Math.floor((BAND.x0 * w) / TILE), tx1 = Math.ceil((BAND.x1 * w) / TILE), ty0 = Math.floor((BAND.y0 * h) / TILE), ty1 = Math.ceil((BAND.y1 * h) / TILE);
  const band = [], mean = [];
  const scanner = flashScanner({
    w, h, fps,
    onTiles: (lum, i, tx) => {
      const inBand = [];
      let sum = 0;
      for (let k = 0; k < lum.length; k++) {
        sum += lum[k];
        const x = k % tx, y = Math.floor(k / tx);
        if (x >= tx0 && x < tx1 && y >= ty0 && y < ty1) inBand.push(lum[k]);
      }
      inBand.sort((a, b) => a - b);
      band[i] = inBand.length ? inBand[Math.floor(inBand.length * 0.9)] : 0;
      mean[i] = sum / lum.length;
    },
  });
  const [n, loud] = await Promise.all([frames(file, { w, h, fps }, (px) => scanner.push(px)), info.audio ? loudness(file) : null]);
  if (!n) throw new Error(`no frame of ${file} could be decoded`);
  const flashes = scanner.result();

  const issues = stretches(flashes).map((f) => ({ level: "fail", at: f.t, what: `until ${f.end.toFixed(1)} s, up to ${Math.round(f.share * 100)}% of the frame ${{ general: "flashes", red: "flashes saturated red", pattern: "flickers tile by tile (a pattern reversing)", "red-pattern": "flickers in saturated red, tile by tile" }[f.kind]} more than 3 times a second (WCAG 2.3.1): slow it to 3 flashes a second or fewer, shrink it under a quarter of the frame, or lower its contrast` }));

  let loudReport = null;
  // (ebur128 reports a silent track as -70 LUFS, its gate's floor)
  if (loud && loud.integrated !== null && loud.integrated <= -70) {
    issues.push({ level: "note", what: "the audio track is silent: loudness not checked" });
  } else if (loud && loud.integrated !== null) {
    const sudden = jumps(loud.momentary, loud.integrated);
    loudReport = { integrated: loud.integrated, range: loud.range, truePeak: loud.truePeak, target: lufs, jumps: sudden, momentary: loud.momentary };
    if (Math.abs(loud.integrated - lufs) > LOUD.tolerance) issues.push({ level: "warn", what: `integrated loudness ${loud.integrated} LUFS, ${loud.integrated > lufs ? "above" : "below"} the ${lufs} LUFS target by ${Math.abs(loud.integrated - lufs).toFixed(1)} LU${loud.integrated > lufs ? " (platforms will turn it down)" : " (it will sound weak beside other videos)"}` });
    if (loud.truePeak > LOUD.maxTruePeak) issues.push({ level: "warn", what: `true peak ${loud.truePeak} dBTP, over ${LOUD.maxTruePeak} dBTP: it can clip once encoded` });
    for (const j of sudden.slice(0, 10)) issues.push({ level: "warn", at: j.t, what: `sudden jump: up ${j.rise} LU within a second, to ${j.loudness} LUFS (startling, and hard on headphone listeners)` });
  } else {
    issues.push({ level: "note", what: "no audio stream: loudness not checked" });
  }

  let captions = null;
  if (subtitles) {
    const cues = readSubtitles(subtitles);
    if (!cues.length) throw new Error(`${subtitles} holds no cue that could be read (SRT, WebVTT or ASS)`);
    const reading = readingIssues(cues);
    const low = contrastIssues(cues, band, fps, { color: captionColor });
    captions = { file: path.basename(subtitles), cues: cues.map((c) => ({ start: c.start, end: c.end })), reading, contrast: low };
    for (const c of reading) issues.push({ level: "warn", at: c.start, what: `caption "${c.text.slice(0, 50)}${c.text.length > 50 ? "…" : ""}": ${c.issues.join("; ")}` });
    for (const c of low) issues.push({ level: "warn", at: c.start, what: `caption "${c.text.slice(0, 50)}${c.text.length > 50 ? "…" : ""}": ${captionColor} text reaches ${c.ratio}:1 against the picture behind it (under ${RULES.minContrast}:1): give it an outline, a shadow or a box` });
  }

  issues.sort((a, b) => (a.at ?? -1) - (b.at ?? -1));
  const perSecond = [];
  for (let s = 0; s * fps < mean.length; s++) { const xs = mean.slice(s * fps, (s + 1) * fps); perSecond.push(xs.reduce((a, b) => a + b, 0) / xs.length); }
  return {
    file: path.basename(file), duration: info.duration || n / fps, width: info.width, height: info.height, fps, frames: n,
    flashes, loudness: loudReport, captions, brightness: perSecond,
    issues, verdict: issues.some((i) => i.level === "fail") ? "fail" : issues.some((i) => i.level === "warn") ? "warn" : "pass",
  };
}

module.exports = { checkVideo, jumps, stretches, targetOf, TARGETS, LOUD, BAND };
