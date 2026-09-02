import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const ROOT = process.cwd();
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const RUNTIME_DIR = path.join(ROOT, "runtime", "requests");

export type LocalKind = "uploads" | "outputs";

type DetectedFile = { extension: string; mimeType: string };

export async function saveUpload(file: File): Promise<{ id: string; url: string }> {
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) {
    throw new Error("Files must be between 1 byte and 25 MB");
  }
  const detected = detectMedia(bytes);
  if (!detected || !declaredTypeMatches(file.type, detected.mimeType)) {
    throw new Error("Use PNG, JPEG, WebP, GIF, MP4, or WAV files");
  }
  const id = `${crypto.randomBytes(16).toString("hex")}.${detected.extension}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, id), bytes, { mode: 0o600 });
  return { id, url: `/api/cua/uploads/${id}` };
}

export async function saveOutput(
  bytes: Buffer,
  _declaredMimeType: string,
): Promise<{ url: string; mimeType: string }> {
  if (bytes.length === 0 || bytes.length > 250 * 1024 * 1024) {
    throw new Error("Generated media must be between 1 byte and 250 MB");
  }
  const detected = detectMedia(bytes);
  if (!detected) throw new Error("The generated file is not a supported media type");
  const id = `${crypto.randomBytes(16).toString("hex")}.${detected.extension}`;
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, id), bytes, { mode: 0o600 });
  return { url: `/api/cua/outputs/${id}`, mimeType: detected.mimeType };
}

export async function readLocalFile(kind: LocalKind, name: string) {
  if (!/^[a-f0-9]{32}\.(?:png|jpg|webp|gif|mp4|wav|json)$/.test(name)) return null;
  const directory = kind === "uploads" ? UPLOAD_DIR : OUTPUT_DIR;
  try {
    const bytes = await readFile(path.join(directory, name));
    return { bytes, mimeType: mimeFromName(name) };
  } catch {
    return null;
  }
}

export async function localMediaData(url: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const match = url.match(/^\/api\/cua\/(uploads|outputs)\/([^/?#]+)$/);
  if (!match) return null;
  return readLocalFile(match[1] as LocalKind, match[2]!);
}

export async function writeRequestState(requestId: string, state: unknown): Promise<void> {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(path.join(RUNTIME_DIR, `${requestId}.json`), JSON.stringify(state), { mode: 0o600 });
}

export async function readRequestState<T>(requestId: string): Promise<T | null> {
  if (!/^[a-f0-9]{32}$/.test(requestId)) return null;
  try {
    return JSON.parse(await readFile(path.join(RUNTIME_DIR, `${requestId}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}

function detectMedia(bytes: Buffer): DetectedFile | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") {
    return { extension: "webp", mimeType: "image/webp" };
  }
  if (bytes.subarray(0, 6).toString() === "GIF87a" || bytes.subarray(0, 6).toString() === "GIF89a") {
    return { extension: "gif", mimeType: "image/gif" };
  }
  if (bytes.subarray(4, 8).toString() === "ftyp") {
    return { extension: "mp4", mimeType: "video/mp4" };
  }
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE") {
    return { extension: "wav", mimeType: "audio/wav" };
  }
  return null;
}

function declaredTypeMatches(declared: string, detected: string): boolean {
  return declared === detected || (declared === "audio/x-wav" && detected === "audio/wav");
}

function mimeFromName(name: string): string {
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".json")) return "application/json";
  return "image/png";
}
