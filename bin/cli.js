#!/usr/bin/env node
const fs = require("fs");
const { parseArgs } = require("util");
const { checkVideo, TARGETS } = require("../src/index");
const report = require("../src/report");

const HELP = `video-safety-check: flashes, red flashes, reversing patterns, caption legibility and loudness, for any video

  video-safety-check <video> [--subtitles captions.srt] [--caption-color #ffffff] [--loudness streaming]
                     [--svg report.svg] [--json] [--strict]

--subtitles      an SRT, WebVTT or ASS file: reading speed, line length and contrast against the picture
--caption-color  the captions' text colour, for the contrast check (default #ffffff)
--loudness       target loudness: a LUFS number or ${Object.entries(TARGETS).map(([k, v]) => `${k} (${v})`).join(", ")}
--svg            also write the report as an SVG timeline
--json           print the full report as JSON
--strict         exit 1 on warnings too, not only on flashes

Exit codes: 0 pass, 1 fail (a flash risk; with --strict, any warning), 2 the check could not run.
Needs ffmpeg and ffprobe on PATH (or FFMPEG_PATH and FFPROBE_PATH).`;

async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { subtitles: { type: "string" }, "caption-color": { type: "string", default: "#ffffff" }, loudness: { type: "string", default: "streaming" }, svg: { type: "string" }, json: { type: "boolean" }, strict: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (o.help || !positionals.length) { console.log(HELP); return 0; }
  let code = 0;
  for (const file of positionals) {
    const r = await checkVideo(file, { subtitles: o.subtitles, captionColor: o["caption-color"], target: o.loudness });
    if (o.svg) fs.writeFileSync(positionals.length > 1 ? o.svg.replace(/(\.svg)?$/i, `-${r.file.replace(/[^\w.-]+/g, "_")}.svg`) : o.svg, report.svg(r));
    console.log(o.json ? JSON.stringify(r, (k, v) => (k === "momentary" ? undefined : v), 1) : report.text(r));
    if (r.verdict === "fail" || (o.strict && r.verdict === "warn")) code = 1;
  }
  return code;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`video-safety-check: ${e.message}`); process.exitCode = 2; });
