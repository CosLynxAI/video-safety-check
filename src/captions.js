// Caption legibility: reading speed and layout from a subtitle file (SRT, WebVTT or ASS), and contrast against the
// picture under where captions sit.
const fs = require("fs");

/**
 * The house rules most streaming and broadcast style guides share (Netflix's timed text guide, BBC subtitle guidelines):
 * at most 20 characters a second, at least 5/6 s on screen, at most 42 characters a line and 2 lines; and WCAG's 4.5:1
 * contrast for text without an outline or box.
 */
const RULES = { maxCps: 20, minSeconds: 5 / 6, maxLineChars: 42, maxLines: 2, minContrast: 4.5 };

const stamp = (s) => {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(String(s).trim());
  if (!m) return NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
};

/** Cues [{ start, end, lines }] from subtitle text, its format read from its content (ASS, WebVTT, else SRT). */
function parseSubtitles(text) {
  const src = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (/^\[Script Info\]/m.test(src)) {
    // ASS: the Format line of [Events] says where Start, End and Text are; override tags {...} and \N line breaks
    const format = /^\[Events\][\s\S]*?^Format:\s*(.+)$/m.exec(src)?.[1].split(",").map((s) => s.trim().toLowerCase()) || ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    return src.split("\n").filter((l) => /^Dialogue:/.test(l)).map((l) => {
      const parts = l.replace(/^Dialogue:\s*/, "").split(",");
      const f = Object.fromEntries(format.map((k, i) => [k, i === format.length - 1 ? parts.slice(i).join(",") : parts[i]]));
      return { start: stamp(f.start), end: stamp(f.end), lines: String(f.text || "").replace(/\{[^}]*\}/g, "").split(/\\N|\\n/).map((s) => s.trim()).filter(Boolean) };
    }).filter((c) => c.end > c.start && c.lines.length);
  }
  return src.split(/\n{2,}/).map((block) => {
    const rows = block.split("\n").filter((r) => r.trim());
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at < 0) return null;
    const [a, b] = rows[at].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    return { start: stamp(a), end: stamp(b), lines: rows.slice(at + 1).map((r) => r.replace(/<[^>]*>/g, "").trim()).filter(Boolean) };
  }).filter((c) => c && c.end > c.start && c.lines.length);
}

const readSubtitles = (file) => parseSubtitles(fs.readFileSync(file, "utf8"));

/** Each cue's reading problems: [{ start, end, text, issues: [string] }] for the cues that have any. */
function readingIssues(cues, rules = RULES) {
  return cues.map((c) => {
    const text = c.lines.join(" ");
    const seconds = c.end - c.start;
    const cps = text.replace(/\s+/g, " ").length / seconds;
    const issues = [];
    if (cps > rules.maxCps) issues.push(`${cps.toFixed(1)} characters a second (most viewers read ${rules.maxCps} at most): hold it longer or cut words`);
    if (seconds < rules.minSeconds) issues.push(`on screen ${seconds.toFixed(2)} s (under ${rules.minSeconds.toFixed(2)} s, too brief to read)`);
    const long = c.lines.filter((l) => l.length > rules.maxLineChars);
    if (long.length) issues.push(`a line of ${Math.max(...long.map((l) => l.length))} characters (over ${rules.maxLineChars}): break it`);
    if (c.lines.length > rules.maxLines) issues.push(`${c.lines.length} lines (over ${rules.maxLines}): split the cue`);
    return { start: c.start, end: c.end, text, issues };
  }).filter((c) => c.issues.length);
}

/** WCAG contrast ratio of two relative luminances. */
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Relative luminance of a #rrggbb colour. */
function luminanceOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(m[1], 16);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/**
 * The cues whose caption colour stands too close to the picture behind them: the band's brightest tenth (bandLum,
 * one value a frame at `fps`) during the cue, against `color`, under rules.minContrast. [{ start, end, text, ratio }]
 */
function contrastIssues(cues, bandLum, fps, { color = "#ffffff", rules = RULES } = {}) {
  const text = luminanceOf(color);
  return cues.map((c) => {
    const span = bandLum.slice(Math.floor(c.start * fps), Math.max(Math.floor(c.start * fps) + 1, Math.ceil(c.end * fps)));
    if (!span.length) return null;
    // (the worst moment counts: one bright frame behind white text is where it disappears)
    const ratio = Math.min(...span.map((l) => contrast(text, l)));
    return ratio < rules.minContrast ? { start: c.start, end: c.end, text: c.lines.join(" "), ratio: Math.round(ratio * 10) / 10 } : null;
  }).filter(Boolean);
}

module.exports = { parseSubtitles, readSubtitles, readingIssues, contrastIssues, contrast, luminanceOf, RULES };
