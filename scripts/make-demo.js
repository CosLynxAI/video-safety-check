#!/usr/bin/env node
// Builds a 14 s test video with ffmpeg, one problem per stretch, and its subtitles:
//   node scripts/make-demo.js <dir>   ->  <dir>/demo.mp4, <dir>/demo.srt
//  0-4 s    calm test pattern, a quiet tone
//  4-6 s    a full-frame black and white strobe at 5 Hz (fails)
//  6-8 s    saturated red flashing at 5 Hz, its brightness nearly steady (fails as a red flash)
//  8-10 s   a checkerboard reversing at 5 Hz (fails as a pattern)
//  10-14 s  a bright, calm scene; a burst of noise at 12 s (a sudden jump), and white captions over it
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function makeDemo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const S = "320x180", R = 30;
  const video = [
    `testsrc2=s=${S}:r=${R}:d=4,format=yuv420p[a]`,
    `color=c=black:s=${S}:r=${R}:d=2,geq=lum='if(lt(mod(N\\,6)\\,3)\\,235\\,16)':cb=128:cr=128,format=yuv420p[b]`,
    `color=c=black:s=${S}:r=${R}:d=2,format=rgb24,geq=r='if(lt(mod(N\\,6)\\,3)\\,255\\,200)':g='if(lt(mod(N\\,6)\\,3)\\,0\\,30)':b='if(lt(mod(N\\,6)\\,3)\\,0\\,30)',format=yuv420p[c]`,
    `color=c=black:s=${S}:r=${R}:d=2,geq=lum='if(eq(mod(floor(X/20)+floor(Y/20)+floor(N/3)\\,2)\\,0)\\,235\\,16)':cb=128:cr=128,format=yuv420p[d]`,
    `color=c=0xd8e4ee:s=${S}:r=${R}:d=4,drawbox=x=40:y=30:w=240:h=70:color=0x30507a:t=fill,format=yuv420p[e]`,
    `[a][b][c][d][e]concat=n=5:v=1:a=0[v]`,
  ].join(";");
  const audio = "aevalsrc='if(between(t\\,12\\,12.6)\\,0.9*(random(0)*2-1)\\,0.08*sin(2*PI*220*t))':s=48000:d=14";
  const out = path.join(dir, "demo.mp4");
  const r = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-v", "error", "-y", "-filter_complex", video, "-f", "lavfi", "-i", audio, "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
  fs.writeFileSync(path.join(dir, "demo.srt"), [
    "1\n00:00:00,500 --> 00:00:03,000\nA calm opening, easy to read.\n",
    "2\n00:00:03,100 --> 00:00:03,700\nThis caption carries far too many words for the moment it is on screen.\n",
    "3\n00:00:10,500 --> 00:00:13,500\nWhite words over a pale sky.\n",
  ].join("\n"));
  return { video: out, subtitles: path.join(dir, "demo.srt") };
}

if (require.main === module) console.log(makeDemo(process.argv[2] || "demo"));
module.exports = { makeDemo };
