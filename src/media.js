// ffmpeg and ffprobe, from PATH or FFMPEG_PATH / FFPROBE_PATH.
const { spawn, spawnSync } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function need(bin) {
  const r = spawnSync(bin, ["-version"], { encoding: "utf8", windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`${bin} was not found: install ffmpeg (https://ffmpeg.org/download.html) or set FFMPEG_PATH and FFPROBE_PATH`);
}

const rate = (s) => { const [a, b] = String(s || "").split("/").map(Number); return a > 0 && b > 0 ? a / b : a > 0 && !b ? a : 0; };

/** { width, height, fps, duration, audio } of a video, as shown (a rotated phone video's sides swapped). */
function probe(file) {
  need(FFPROBE);
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffprobe could not read ${file}: ${String(r.stderr).trim().split("\n").pop()}`);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!v) throw new Error(`${file} has no video stream`);
  const rot = Math.abs(Number(v.tags?.rotate || (v.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation || 0)) % 180;
  return {
    width: rot === 90 ? v.height : v.width, height: rot === 90 ? v.width : v.height,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30,
    duration: Number(j.format?.duration || v.duration || 0),
    audio: (j.streams || []).some((s) => s.codec_type === "audio"),
  };
}

/** Decodes `file` as RGB24 frames of `w` x `h` at `fps`, calling onFrame(buffer, i) for each; resolves the count. */
function frames(file, { w, h, fps }, onFrame) {
  need(FFMPEG);
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-an", "-sn", "-vf", `fps=${fps},scale=${w}:${h}:flags=area,format=rgb24`, "-f", "rawvideo", "-"], { windowsHide: true });
    const size = w * h * 3;
    let buf = Buffer.alloc(0), n = 0, err = "", failed = null;
    p.stdout.on("data", (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size && !failed) {
        try { onFrame(buf.subarray(0, size), n++); } catch (e) { failed = e; p.kill(); }
        buf = buf.subarray(size);
      }
    });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (failed) return reject(failed);
      if (code !== 0 && !n) return reject(new Error(`ffmpeg could not decode ${file}: ${err.trim().split("\n").pop()}`));
      resolve(n);
    });
  });
}

/**
 * EBU R128 loudness of the first audio stream: { integrated (LUFS), range (LU), truePeak (dBTP), momentary: [[t, M]] }
 * (momentary: 400 ms loudness every 100 ms), or null with no audio.
 */
function loudness(file) {
  need(FFMPEG);
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-nostats", "-hide_banner", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return /matches no streams/i.test(err) ? resolve(null) : reject(new Error(`ffmpeg could not measure loudness: ${err.trim().split("\n").pop()}`));
      const summary = err.slice(err.lastIndexOf("Summary:"));
      const num = (re) => { const m = re.exec(summary); return m ? (m[1] === "-inf" ? -120 : Number(m[1])) : null; };
      const momentary = [...err.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)/g)].map((m) => [Number(m[1]), m[2] === "-inf" ? -120 : Number(m[2])]);
      resolve({ integrated: num(/I:\s+(-?[\d.]+) LUFS/), range: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/) ?? -120, momentary });
    });
  });
}

module.exports = { probe, frames, loudness, FFMPEG, FFPROBE };
