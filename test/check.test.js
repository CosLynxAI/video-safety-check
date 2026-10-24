const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { flashScanner, analysisSize } = require("../src/flash");
const { parseSubtitles, readingIssues, contrastIssues, contrast, luminanceOf } = require("../src/captions");
const { jumps, stretches, targetOf } = require("../src/index");

const W = 60, H = 60, FPS = 30;
/** A scanner's flash kinds over `seconds` of frames painted by paint(x, y, i) -> [r, g, b]. */
function scan(paint, seconds = 2) {
  const s = flashScanner({ w: W, h: H, fps: FPS });
  for (let i = 0; i < seconds * FPS; i++) {
    const px = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(paint(x, y, i), (y * W + x) * 3);
    s.push(px);
  }
  return s.result();
}
const kinds = (f) => [...new Set(f.map((x) => x.kind))].sort();
const BW = (on) => (on ? [255, 255, 255] : [0, 0, 0]);

test("a full-frame strobe at 5 Hz fails as a general flash", () => {
  const f = scan((x, y, i) => BW(Math.floor(i / 3) % 2));
  assert.deepEqual(kinds(f), ["general"]);
  assert.equal(f[0].share, 1);
});

test("3 flashes a second or fewer pass", () => {
  assert.deepEqual(scan((x, y, i) => BW(Math.floor(i / 8) % 2), 3), []);
  assert.deepEqual(scan((x, y, i) => BW(Math.floor(i / 5) % 2), 3), []);
});

test("flashing under a quarter of the frame passes; over it fails", () => {
  // 30x30 of 60x60 is 25%: the limit itself is allowed; 36x36 is 36%
  assert.deepEqual(scan((x, y, i) => BW(x < 30 && y < 30 && Math.floor(i / 3) % 2)), []);
  assert.notDeepEqual(scan((x, y, i) => BW(x < 36 && y < 36 && Math.floor(i / 3) % 2)), []);
});

test("a dim flash (both states bright, change under 0.1 luminance) passes", () => {
  assert.deepEqual(scan((x, y, i) => (Math.floor(i / 3) % 2 ? [250, 250, 250] : [235, 235, 235])), []);
});

test("saturated red flashing with steady brightness fails as a red flash only", () => {
  const f = scan((x, y, i) => (Math.floor(i / 3) % 2 ? [255, 0, 0] : [200, 30, 30]));
  assert.deepEqual(kinds(f), ["red"]);
});

test("a checkerboard reversing at 5 Hz fails", () => {
  const f = scan((x, y, i) => BW((Math.floor(x / 12) + Math.floor(y / 12) + Math.floor(i / 3)) % 2));
  assert.ok(f.length > 0);
  assert.ok(kinds(f).every((k) => ["general", "pattern"].includes(k)), kinds(f).join());
});

test("a still frame and a slow fade pass", () => {
  assert.deepEqual(scan(() => [128, 128, 128]), []);
  assert.deepEqual(scan((x, y, i) => { const v = Math.round((i / 60) * 255); return [v, v, v]; }), []);
});

test("analysis size keeps the aspect in whole tiles, long side 192", () => {
  assert.deepEqual(analysisSize(1920, 1080), { w: 192, h: 108 });
  assert.deepEqual(analysisSize(1080, 1920), { w: 108, h: 192 });
  assert.deepEqual(analysisSize(640, 480), { w: 192, h: 144 });
});

test("flashing seconds of one kind join into stretches", () => {
  const s = stretches([{ t: 4, kind: "general", share: 1 }, { t: 5, kind: "general", share: 0.5 }, { t: 6, kind: "red", share: 1 }, { t: 9, kind: "general", share: 1 }]);
  assert.deepEqual(s.map((x) => [x.kind, x.t, x.end]), [["general", 4, 6], ["red", 6, 7], ["general", 9, 10]]);
});

test("subtitles: SRT, WebVTT and ASS read the same", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>there</i>\r\nsecond line\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n";
  const vtt = "WEBVTT\n\nintro\n00:01.000 --> 00:02.500 align:center\nHello <i>there</i>\nsecond line\n\n00:03.000 --> 00:04.000\nBye\n";
  const ass = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\k20}Hello {\\b1}there{\\b0}\\Nsecond line\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Bye\n";
  const want = [{ start: 1, end: 2.5, lines: ["Hello there", "second line"] }, { start: 3, end: 4, lines: ["Bye"] }];
  assert.deepEqual(parseSubtitles(srt), want);
  assert.deepEqual(parseSubtitles(vtt), want);
  assert.deepEqual(parseSubtitles(ass), want);
});

test("reading speed, duration, line length and line count", () => {
  const issues = readingIssues([
    { start: 0, end: 3, lines: ["Easy to read."] },
    { start: 3, end: 3.5, lines: ["Far too many words for half a second on screen"] },
    { start: 4, end: 9, lines: ["one", "two", "three"] },
  ]);
  assert.equal(issues.length, 2);
  assert.match(issues[0].issues.join(" "), /characters a second.*too brief.*a line of 46 characters/);
  assert.match(issues[1].issues.join(" "), /3 lines/);
});

test("caption contrast: white on near-white fails, white on dark passes", () => {
  assert.equal(Math.round(contrast(1, 0) * 10) / 10, 21);
  assert.equal(Math.round(luminanceOf("#777777") * 1000) / 1000, 0.184);
  const cues = [{ start: 0, end: 1, lines: ["dark"] }, { start: 1, end: 2, lines: ["bright"] }];
  const band = [...Array(30).fill(0.02), ...Array(29).fill(0.02), 0.9];
  const low = contrastIssues(cues, band, 30);
  assert.deepEqual(low.map((c) => c.text), ["bright"], "one bright frame behind the cue is enough to lose it");
  assert.deepEqual(contrastIssues(cues, band.map(() => 0.9), 30, { color: "#000000" }), []);
});

test("loudness: a startling jump is found once, a steady programme has none", () => {
  const steady = Array.from({ length: 100 }, (_, i) => [i / 10, -16]);
  assert.deepEqual(jumps(steady, -16), []);
  const bang = steady.map(([t, m]) => [t, t >= 5 && t < 5.6 ? 0 : m]);
  const j = jumps(bang, -16);
  assert.equal(j.length, 1);
  assert.equal(j[0].t, 5);
  assert.equal(targetOf("ebu"), -23);
  assert.equal(targetOf("-16"), -16);
  assert.throws(() => targetOf("loud"));
});

const ffmpeg = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0 && spawnSync(process.env.FFPROBE_PATH || "ffprobe", ["-version"]).status === 0;

test("a real video end to end: each problem found where it is, and nothing in the calm stretch", { skip: !ffmpeg && "ffmpeg is not installed" }, async () => {
  const { makeDemo } = require("../scripts/make-demo");
  const { checkVideo } = require("../src/index");
  const report = require("../src/report");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-"));
  try {
    const { video, subtitles } = makeDemo(dir);
    const r = await checkVideo(video, { subtitles });
    assert.equal(r.verdict, "fail");
    const at = (kind) => r.flashes.filter((f) => f.kind === kind).map((f) => Math.floor(f.t));
    assert.deepEqual(at("general"), [4, 5]);
    assert.deepEqual(at("red"), [6, 7]);
    assert.ok(at("pattern").length >= 1 && at("pattern").every((s) => s >= 8 && s < 10), JSON.stringify(r.flashes));
    assert.ok(r.flashes.every((f) => f.t >= 4 && f.t < 10), "the calm test pattern and the bright scene do not flash");
    assert.deepEqual(r.loudness.jumps.map((j) => Math.round(j.t)), [12]);
    assert.ok(r.captions.reading.some((c) => /too brief/.test(c.issues.join())));
    assert.ok(r.captions.contrast.some((c) => /pale sky/.test(c.text)));
    assert.match(report.text(r), /FAIL: flashes/);
    assert.match(report.svg(r), /^<svg[\s\S]*FAIL: FLASH RISK[\s\S]*<\/svg>\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
