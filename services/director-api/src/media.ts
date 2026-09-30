import { createWriteStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { EditPlan, Project, Silence, TranscriptSegment, Version } from "./types.js";
import { projectDir, saveProject } from "./store.js";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const maxSourceBytes = Number(process.env.MAX_SOURCE_BYTES || 2 * 1024 * 1024 * 1024);

function run(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}

function sourceExtension(url: string) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".mp4";
  } catch {
    return ".mp4";
  }
}

export async function ensureSource(project: Project) {
  if (project.sourceFile) {
    const existing = path.isAbsolute(project.sourceFile) ? project.sourceFile : path.join(projectDir(project.id), project.sourceFile);
    await access(existing);
    return existing;
  }
  if (!project.sourceUrl) throw Object.assign(new Error("Project has no sourceUrl or sourceFile"), { statusCode: 422 });
  const url = new URL(project.sourceUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("sourceUrl must use http or https"), { statusCode: 422 });
  const target = path.join(projectDir(project.id), "source", `original${sourceExtension(project.sourceUrl)}`);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Source download failed: ${response.status} ${response.statusText}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length && length > maxSourceBytes) throw Object.assign(new Error("Source exceeds MAX_SOURCE_BYTES"), { statusCode: 413 });
  await pipeline(response.body as any, createWriteStream(target));
  const downloaded = await stat(target);
  if (downloaded.size > maxSourceBytes) throw Object.assign(new Error("Source exceeds MAX_SOURCE_BYTES"), { statusCode: 413 });
  project.sourceFile = path.relative(projectDir(project.id), target).replace(/\\/g, "/");
  await saveProject(project);
  return target;
}

async function probe(file: string) {
  const { stdout } = await run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const info = JSON.parse(stdout);
  const video = info.streams?.find((stream: any) => stream.codec_type === "video");
  const audio = info.streams?.find((stream: any) => stream.codec_type === "audio");
  const [num, den] = String(video?.avg_frame_rate || "0/1").split("/").map(Number);
  return {
    duration: Number(info.format?.duration || video?.duration || 0),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    fps: den ? num / den : 0,
    codec: video?.codec_name,
    audioCodec: audio?.codec_name,
  };
}

async function detectSilences(file: string): Promise<Silence[]> {
  const { stderr } = await run(ffmpeg, ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.45", "-f", "null", "-"]);
  const starts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g)];
  return ends.map((match, index) => ({ start: starts[index] ?? Math.max(0, Number(match[1]) - Number(match[2])), end: Number(match[1]), duration: Number(match[2]) }));
}

async function transcribe(project: Project, file: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { text: "", segments: [] as TranscriptSegment[], warning: "OPENAI_API_KEY is not configured; media analysis completed without transcription." };
  const audio = path.join(projectDir(project.id), "work", "audio.mp3");
  await run(ffmpeg, ["-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio]);
  const form = new FormData();
  form.set("model", process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe");
  form.set("response_format", "verbose_json");
  form.set("file", new Blob([await readFile(audio)]), "audio.mp3");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(30 * 60_000) });
  const body: any = await response.json();
  if (!response.ok) throw new Error(`Transcription failed: ${body?.error?.message || response.statusText}`);
  return {
    language: body.language,
    text: body.text || "",
    segments: (body.segments || []).map((segment: any) => ({ start: Number(segment.start), end: Number(segment.end), text: String(segment.text || "").trim() })),
  };
}

export async function analyze(project: Project) {
  const file = await ensureSource(project);
  const metadata = await probe(file);
  const [silences, transcript] = metadata.audioCodec
    ? await Promise.all([detectSilences(file), transcribe(project, file)])
    : [[], { text: "", segments: [] as TranscriptSegment[], warning: "The source has no audio stream; transcription and silence detection were skipped." }];
  Object.assign(project, metadata, { silences, transcript, status: "analyzed", error: undefined });
  await saveProject(project);
  return project;
}

export function buildPlan(project: Project): EditPlan {
  if (!project.duration) throw Object.assign(new Error("Analyze the project before generating a plan"), { statusCode: 409 });
  const cuts = project.silences.filter((silence) => silence.duration >= 0.7).map((silence) => ({ start: silence.start, end: silence.end, reason: "Remove detected silence" }));
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor + 0.05) keep.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < project.duration) keep.push({ start: cursor, end: project.duration });
  return {
    generatedAt: new Date().toISOString(),
    strategy: "Preserve the original narrative while removing long silences; normalize audio and retain transcript timing for captions.",
    keep: keep.length ? keep : [{ start: 0, end: project.duration }],
    cuts,
    captions: project.transcript.segments.map((segment) => ({ ...segment })),
    visuals: [],
    audio: { normalize: true, targetLufs: -14 },
  };
}

export async function render(project: Project, revision = false): Promise<Version> {
  const file = await ensureSource(project);
  const plan = project.editPlan;
  if (!plan) throw Object.assign(new Error("Generate an edit plan before rendering"), { statusCode: 409 });
  const versionNumber = project.latestVersion + 1;
  const output = path.join(projectDir(project.id), "renders", `v${String(versionNumber).padStart(3, "0")}.mp4`);
  const started = Date.now();
  const keep = plan.keep.filter((segment) => segment.end > segment.start);
  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  const hasAudio = Boolean(project.audioCodec);
  keep.forEach((segment, index) => {
    filterParts.push(`[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${index}]`);
    if (hasAudio) {
      filterParts.push(`[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${index}]`);
      concatInputs.push(`[v${index}][a${index}]`);
    } else {
      concatInputs.push(`[v${index}]`);
    }
  });
  filterParts.push(`${concatInputs.join("")}concat=n=${keep.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? "[a]" : ""}`);
  if (hasAudio) filterParts.push("[a]loudnorm=I=-14:TP=-1.5:LRA=11[an]");
  const outputArgs = ["-y", "-i", file, "-filter_complex", filterParts.join(";"), "-map", "[v]"];
  if (hasAudio) outputArgs.push("-map", "[an]");
  outputArgs.push("-c:v", "libx264", "-preset", "medium", "-crf", "20");
  if (hasAudio) outputArgs.push("-c:a", "aac", "-b:a", "192k");
  outputArgs.push("-movflags", "+faststart", output);
  await run(ffmpeg, outputArgs);
  const outputInfo = await probe(output);
  const pendingFeedback = project.feedback.filter((item) => !item.appliedInVersion);
  pendingFeedback.forEach((item) => (item.appliedInVersion = versionNumber));
  const version: Version = {
    version: versionNumber,
    createdAt: new Date().toISOString(),
    file: path.relative(projectDir(project.id), output).replace(/\\/g, "/"),
    duration: outputInfo.duration,
    renderTimeSeconds: (Date.now() - started) / 1000,
    revision,
    feedbackApplied: pendingFeedback.map((item) => item.note),
  };
  project.versions.push(version);
  project.latestVersion = versionNumber;
  project.status = "rendered";
  await saveProject(project);
  return version;
}
