// A check's report as text for the terminal, and as an SVG timeline.
const { stretches } = require("./index");
const KIND = { general: ["flash", "#f85149"], red: ["red flash", "#da3633"], pattern: ["reversing pattern", "#bc4c00"], "red-pattern": ["red pattern", "#8e1519"] };
const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function text(r) {
  const head = `${r.file}: ${r.width}x${r.height}, ${r.duration.toFixed(1)} s, checked at ${r.fps} fps`;
  const loud = r.loudness ? `loudness ${r.loudness.integrated} LUFS (target ${r.loudness.target}), range ${r.loudness.range} LU, true peak ${r.loudness.truePeak} dBTP` : "loudness not checked";
  const caps = r.captions ? `${r.captions.cues.length} captions from ${r.captions.file}` : "no subtitle file given (--subtitles to check captions)";
  const mark = { fail: "FAIL", warn: "warn", note: "note" };
  const lines = r.issues.map((i) => `  ${mark[i.level].padEnd(4)}  ${i.at !== undefined ? clock(i.at).padStart(7) : "       "}  ${i.what}`);
  const verdict = { pass: "PASS: no flash risk, nothing else off", warn: "PASS on flashes, with warnings", fail: "FAIL: flashes that can trigger seizures" }[r.verdict];
  return [head, `  ${loud}`, `  ${caps}`, "", ...(lines.length ? lines : ["  nothing to report"]), "", verdict].join("\n");
}

function svg(r) {
  const W = 1000, L = 120, R = 24, X = (t) => L + (Math.min(t, r.duration) / Math.max(r.duration, 0.1)) * (W - L - R);
  const rows = [];
  let y = 92;
  const track = (label, height, body) => { rows.push(`<text x="16" y="${y + height / 2 + 5}" class="l">${label}</text><rect x="${L}" y="${y}" width="${W - L - R}" height="${height}" fill="#161b22" rx="4"/>${body(y, height)}`); y += height + 18; };

  track("Flashes", 34, (y0, hh) => stretches(r.flashes).map((f) => { const [name, fill] = KIND[f.kind]; const w = Math.max(3, X(f.end) - X(f.t) - 2); return `<rect x="${X(f.t).toFixed(1)}" y="${y0}" width="${w.toFixed(1)}" height="${hh}" fill="${fill}" rx="3"/>${w > name.length * 6.5 ? `<text x="${(X(f.t) + w / 2).toFixed(1)}" y="${y0 + 22}" text-anchor="middle" style="font-size:12px;font-weight:600">${name}</text>` : ""}`; }).join("") || `<text x="${L + 10}" y="${y0 + 22}" class="s">none</text>`);
  track("Brightness", 60, (y0, hh) => {
    const pts = r.brightness.map((b, s) => `${X(s + 0.5).toFixed(1)},${(y0 + hh - 4 - b * (hh - 8)).toFixed(1)}`).join(" ");
    return pts ? `<polyline points="${pts}" fill="none" stroke="#e3b341" stroke-width="2"/>` : "";
  });
  if (r.loudness) {
    track("Loudness", 80, (y0, hh) => {
      const Y = (m) => y0 + hh - 4 - ((Math.max(-60, Math.min(0, m)) + 60) / 60) * (hh - 8);
      const pts = r.loudness.momentary.map(([t, m]) => `${X(t).toFixed(1)},${Y(m).toFixed(1)}`).join(" ");
      return `<line x1="${L}" x2="${W - R}" y1="${Y(r.loudness.target)}" y2="${Y(r.loudness.target)}" stroke="#8b949e" stroke-dasharray="4 4"/><text x="${L + 6}" y="${Y(r.loudness.target) - 4}" class="s">target ${r.loudness.target} LUFS</text>`
        + `<polyline points="${pts}" fill="none" stroke="#58a6ff" stroke-width="1.5"/>`
        + r.loudness.jumps.map((j) => `<path d="M${X(j.t).toFixed(1)} ${Y(j.loudness) - 10}l-6 -9h12z" fill="#f0883e"><title>${esc(`${clock(j.t)} jump of ${j.rise} LU`)}</title></path>`).join("");
    });
  }
  if (r.captions) {
    const bad = new Set([...r.captions.reading, ...r.captions.contrast].map((c) => c.start));
    track("Captions", 26, (y0, hh) => r.captions.cues.map((c) => `<rect x="${X(c.start).toFixed(1)}" y="${y0 + 3}" width="${Math.max(2, X(c.end) - X(c.start) - 1).toFixed(1)}" height="${hh - 6}" fill="${bad.has(c.start) ? "#f0883e" : "#3fb950"}" rx="2"/>`).join(""));
  }
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => r.duration / s <= 10) || 600;
  const ticks = [];
  for (let t = 0; t <= r.duration + 1e-6; t += step) ticks.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${y - 14}" y2="${y - 8}" stroke="#8b949e"/><text x="${X(t)}" y="${y + 6}" class="s" text-anchor="middle">${clock(t).replace(/\.0$/, "")}</text>`);
  y += 22;
  const listed = r.issues.filter((i) => i.level !== "note").sort((a, b) => (a.level === "fail" ? 0 : 1) - (b.level === "fail" ? 0 : 1)).slice(0, 8);
  const list = listed.map((i, k) => `<text x="16" y="${y + k * 22}" class="i"><tspan fill="${i.level === "fail" ? "#f85149" : "#f0883e"}">${i.level === "fail" ? "FAIL" : "warn"}</tspan>  ${i.at !== undefined ? esc(clock(i.at)) : ""}  ${esc(i.what.length > 118 ? `${i.what.slice(0, 117)}…` : i.what)}</text>`);
  const more = r.issues.filter((i) => i.level !== "note").length - listed.length;
  if (more > 0) list.push(`<text x="16" y="${y + listed.length * 22}" class="s">and ${more} more</text>`);
  const H = y + list.length * 22 + 10;
  const badge = { pass: ["PASS", "#3fb950"], warn: ["PASS, WITH WARNINGS", "#f0883e"], fail: ["FAIL: FLASH RISK", "#f85149"] }[r.verdict];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>text{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;fill:#e6edf3}.l{font-size:14px;font-weight:600}.s{font-size:12px;fill:#8b949e}.i{font-size:13px}.t{font-size:20px;font-weight:700}</style>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<text x="16" y="36" class="t">${esc(r.file)}</text>
<text x="16" y="60" class="s">${r.width}x${r.height} · ${r.duration.toFixed(1)} s · checked at ${r.fps} fps${r.loudness ? ` · ${r.loudness.integrated} LUFS · true peak ${r.loudness.truePeak} dBTP` : ""}</text>
<rect x="${W - R - 12 - badge[0].length * 9.5}" y="18" width="${12 + badge[0].length * 9.5}" height="30" rx="15" fill="${badge[1]}"/><text x="${W - R - 6 - badge[0].length * 4.75}" y="38" text-anchor="middle" style="font-size:14px;font-weight:700;fill:#0d1117">${badge[0]}</text>
${rows.join("\n")}
${ticks.join("")}
${list.join("\n")}
</svg>
`;
}

module.exports = { text, svg, clock };
