import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { Surface } from "./catalog/types";
import { toAuthorizationHeader } from "./credentials";
import {
  localMediaData,
  readRequestState,
  saveOutput,
  writeRequestState,
} from "./local-files";

const REQUEST_TIMEOUT_MS = 2 * 60_000;

export class PlatformError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(messageFromBody(status, body));
    this.name = "PlatformError";
    this.status = status;
    this.body = body;
  }
}

export type QueuedGeneration = {
  status: string;
  requestId: string;
  statusUrl: string;
  cancelUrl: string;
};

export type GenerationStatus = {
  status: string;
  requestId: string;
  images?: Array<{ url: string }>;
  video?: { url: string };
  error?: unknown;
};

export type StatusResult =
  | { requestId: string; status: GenerationStatus }
  | { requestId: string; error: string };

export type PlatformClientOptions = {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
};

type SubmitMeta = { model: string; surface: Surface };
type StoredRequest =
  | { kind: "terminal"; status: GenerationStatus }
  | { kind: "remote"; remotePath: string; remoteRequestId: string; surface: Surface };

export function isModelId(model: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(model) && !model.includes("..");
}

export function createPlatformClient(options: PlatformClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const auth = toAuthorizationHeader(options.apiKey);

  async function send(
    method: "GET" | "POST",
    pathname: string,
    body?: Record<string, unknown> | FormData,
  ): Promise<unknown> {
    const url = gatewayUrl(baseUrl, pathname);
    const isForm = body instanceof FormData;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: auth,
          ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: isForm ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      if (caught instanceof Error && (caught.name === "TimeoutError" || caught.name === "AbortError")) {
        throw new PlatformError(504, { detail: "The Gateway request timed out" });
      }
      throw new PlatformError(502, { detail: "The Gateway could not be reached" });
    }
    const payload = await readJson(response);
    if (!response.ok) throw new PlatformError(response.status, payload);
    return payload;
  }

  async function download(pathname: string, surface: Surface): Promise<string> {
    const url = gatewayUrl(baseUrl, pathname);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PlatformError(502, { detail: "The generated media could not be downloaded" });
    }
    if (!response.ok) throw new PlatformError(response.status, await readJson(response));
    const bytes = await readMediaBytes(response);
    const mimeType = response.headers.get("content-type")?.split(";")[0] || defaultMime(surface);
    return (await saveOutput(bytes, mimeType)).url;
  }

  async function submit(
    _platformPath: string,
    input: Record<string, unknown>,
    meta: SubmitMeta,
  ): Promise<QueuedGeneration> {
    if (!isModelId(meta.model)) throw new PlatformError(400, { detail: "Invalid model" });
    const actualModel = meta.model;

    const refs = stringArray(input.image_urls);
    let payload: unknown;
    if (meta.surface === "image" && actualModel.startsWith("gpt-image") && refs.length > 0) {
      payload = await send("POST", "/images/edits", await gptEditForm(actualModel, input, refs));
    } else {
      const pathname =
        meta.surface === "image"
          ? configuredPath("CUA_IMAGE_CREATE_PATH", "/images/generations")
          : configuredPath("CUA_VIDEO_CREATE_PATH", "/videos/generations");
      payload = await send(
        "POST",
        pathname,
        meta.surface === "image" && actualModel.startsWith("gpt-image")
          ? gptImageBody(actualModel, input)
          : await genericBody(actualModel, input),
      );
    }
    return queueResponse(payload, meta.surface);
  }

  async function queueResponse(payload: unknown, surface: Surface): Promise<QueuedGeneration> {
    const requestId = crypto.randomBytes(16).toString("hex");
    const completed = await materialize(payload, surface, requestId, fetchImpl);
    if (completed) {
      await writeRequestState(requestId, { kind: "terminal", status: completed } satisfies StoredRequest);
      return { status: "queued", requestId, statusUrl: "", cancelUrl: "" };
    }

    const data = asRecord(payload);
    const remoteRequestId = stringField(data, "request_id") ?? stringField(data, "id");
    if (!remoteRequestId) {
      throw new PlatformError(502, { detail: "The Gateway returned no media or request id" });
    }
    const suppliedStatusUrl = stringField(data, "status_url");
    const remotePath = suppliedStatusUrl
      ? gatewayPath(baseUrl, suppliedStatusUrl)
      : surface === "video"
        ? `/videos/${encodeURIComponent(remoteRequestId)}`
        : `/requests/${encodeURIComponent(remoteRequestId)}/status`;
    await writeRequestState(requestId, {
      kind: "remote",
      remotePath,
      remoteRequestId,
      surface,
    } satisfies StoredRequest);
    return {
      status: stringField(data, "status") ?? "queued",
      requestId,
      statusUrl: remotePath,
      cancelUrl: "",
    };
  }

  return {
    submit,
    async status(requestId: string): Promise<GenerationStatus> {
      const stored = await readRequestState<StoredRequest>(requestId);
      if (!stored) throw new PlatformError(404, { detail: "Generation request not found" });
      if (stored.kind === "terminal") return stored.status;

      const payload = await send("GET", stored.remotePath);
      const completed = await materialize(payload, stored.surface, requestId, fetchImpl);
      if (completed) {
        await writeRequestState(requestId, { kind: "terminal", status: completed } satisfies StoredRequest);
        return completed;
      }
      const data = asRecord(payload);
      const status = normalizeStatus(stringField(data, "status") ?? "running");
      if (status === "completed" && stored.surface === "video") {
        const url = await download(`/videos/${encodeURIComponent(stored.remoteRequestId)}/content`, "video");
        const terminal: GenerationStatus = { status, requestId, video: { url } };
        await writeRequestState(requestId, { kind: "terminal", status: terminal } satisfies StoredRequest);
        return terminal;
      }
      if (status === "failed" || status === "canceled" || status === "nsfw") {
        const terminal: GenerationStatus = {
          status,
          requestId,
          ...(data.error !== undefined ? { error: data.error } : {}),
        };
        await writeRequestState(requestId, { kind: "terminal", status: terminal } satisfies StoredRequest);
        return terminal;
      }
      return { status, requestId };
    },
  };

  async function gptEditForm(
    model: string,
    input: Record<string, unknown>,
    refs: string[],
  ): Promise<FormData> {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", requiredPrompt(input));
    const size = gptSize(input.aspect_ratio);
    if (size !== "auto") form.set("size", size);
    const count = numeric(input.num_images);
    if (count) form.set("n", String(count));
    for (const [index, url] of refs.entries()) {
      const local = await localMediaData(url);
      if (!local || !local.mimeType.startsWith("image/")) {
        throw new PlatformError(400, { detail: "A reference image is unavailable" });
      }
      form.append("image", new Blob([new Uint8Array(local.bytes)], { type: local.mimeType }), `reference-${index}`);
    }
    return form;
  }

  async function genericBody(model: string, input: Record<string, unknown>) {
    const body: Record<string, unknown> = { model, ...input, prompt: requiredPrompt(input) };
    for (const key of ["image_urls", "video_urls"] as const) {
      const urls = stringArray(body[key]);
      if (urls.length === 0) continue;
      body[key] = await Promise.all(
        urls.map(async (url) => {
          const local = await localMediaData(url);
          if (!local) throw new PlatformError(400, { detail: "A reference file is unavailable" });
          return `data:${local.mimeType};base64,${local.bytes.toString("base64")}`;
        }),
      );
    }
    return body;
  }
}

function gptImageBody(model: string, input: Record<string, unknown>): Record<string, unknown> {
  const count = numeric(input.num_images);
  return {
    model,
    prompt: requiredPrompt(input),
    size: gptSize(input.aspect_ratio),
    ...(count ? { n: count } : {}),
  };
}

function gptSize(value: unknown): "auto" | "1024x1024" | "1536x1024" | "1024x1536" {
  if (value === "16:9" || value === "4:3" || value === "3:2") return "1536x1024";
  if (value === "9:16" || value === "3:4" || value === "2:3") return "1024x1536";
  return value === "auto" ? "auto" : "1024x1024";
}

async function materialize(
  payload: unknown,
  surface: Surface,
  requestId: string,
  fetchImpl: typeof fetch,
): Promise<GenerationStatus | null> {
  const data = asRecord(payload);
  const status = normalizeStatus(stringField(data, "status") ?? "");
  const candidates = mediaCandidates(data, surface);
  if (candidates.length === 0) {
    if (status === "failed" || status === "canceled" || status === "nsfw") {
      return { status, requestId, ...(data.error !== undefined ? { error: data.error } : {}) };
    }
    return null;
  }

  const urls: string[] = [];
  for (const candidate of candidates) {
    const saved = await saveCandidate(candidate, surface, fetchImpl);
    if (saved) urls.push(saved);
  }
  if (urls.length === 0) throw new PlatformError(502, { detail: "The Gateway returned unusable media" });
  return surface === "image"
    ? { status: "completed", requestId, images: urls.map((url) => ({ url })) }
    : { status: "completed", requestId, video: { url: urls[0]! } };
}

type MediaCandidate = { url?: string; base64?: string; mimeType?: string };

function mediaCandidates(data: Record<string, unknown>, surface: Surface): MediaCandidate[] {
  const values: unknown[] = [];
  if (Array.isArray(data.data)) values.push(...data.data);
  if (Array.isArray(data.images)) values.push(...data.images);
  if (Array.isArray(data.outputs)) values.push(...data.outputs);
  if (Array.isArray(data.output)) values.push(...data.output);
  else if (data.output !== undefined) values.push(data.output);
  if (data.video !== undefined) values.push(data.video);
  if (typeof data.url === "string" || typeof data.b64_json === "string") values.push(data);

  return values.flatMap((value): MediaCandidate[] => {
    if (typeof value === "string") return [{ url: value }];
    const item = asRecord(value);
    const url = stringField(item, "url") ?? stringField(item, "download_url");
    const base64 = stringField(item, "b64_json") ?? stringField(item, "base64");
    if (!url && !base64) return [];
    return [{ url, base64, mimeType: stringField(item, "mime_type") ?? defaultMime(surface) }];
  });
}

async function saveCandidate(
  candidate: MediaCandidate,
  surface: Surface,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  if (candidate.base64) {
    const bytes = Buffer.from(candidate.base64, "base64");
    if (bytes.length === 0 || bytes.length > 250 * 1024 * 1024) {
      throw new PlatformError(502, { detail: "The generated media has an invalid size" });
    }
    const saved = await saveOutput(bytes, candidate.mimeType ?? defaultMime(surface));
    return saved.url;
  }
  if (!candidate.url) return null;
  if (candidate.url.startsWith("/api/cua/outputs/")) return candidate.url;
  const response = await fetchPublicMedia(candidate.url, fetchImpl);
  if (!response.ok) throw new PlatformError(502, { detail: "The generated media could not be downloaded" });
  const bytes = await readMediaBytes(response);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || candidate.mimeType || defaultMime(surface);
  return (await saveOutput(bytes, mimeType)).url;
}

async function fetchPublicMedia(urlValue: string, fetchImpl: typeof fetch): Promise<Response> {
  let current: URL;
  try {
    current = new URL(urlValue);
  } catch {
    throw new PlatformError(502, { detail: "The Gateway returned an invalid media URL" });
  }

  for (let redirects = 0; redirects <= 4; redirects += 1) {
    await assertPublicHttpUrl(current);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PlatformError(502, { detail: "The generated media could not be downloaded" });
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new PlatformError(502, { detail: "The generated media redirect is invalid" });
    current = new URL(location, current);
  }
  throw new PlatformError(502, { detail: "The generated media redirected too many times" });
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new PlatformError(502, { detail: "The Gateway returned an unsafe media URL" });
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new PlatformError(502, { detail: "The Gateway returned an unsafe media URL" });
  }

  let addresses: string[];
  try {
    addresses = isIP(hostname)
      ? [hostname]
      : (await lookup(hostname, { all: true })).map(({ address }) => address);
  } catch {
    throw new PlatformError(502, { detail: "The generated media host could not be resolved" });
  }
  if (addresses.length === 0 || addresses.some(isNonPublicAddress)) {
    throw new PlatformError(502, { detail: "The Gateway returned an unsafe media URL" });
  }
}

function isNonPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isNonPublicAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0, c = 0] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("2001:db8:")
  );
}

async function readMediaBytes(response: Response): Promise<Buffer> {
  const maximum = 250 * 1024 * 1024;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new PlatformError(502, { detail: "The generated media has an invalid size" });
  }
  if (!response.body) throw new PlatformError(502, { detail: "The generated media is empty" });

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new PlatformError(502, { detail: "The generated media has an invalid size" });
    }
    chunks.push(value);
  }
  if (total === 0) throw new PlatformError(502, { detail: "The generated media is empty" });
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function requiredPrompt(input: Record<string, unknown>): string {
  const prompt = input.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw new PlatformError(400, { detail: "Enter a prompt" });
  return prompt.trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeStatus(status: string): string {
  if (status === "succeeded" || status === "success" || status === "done") return "completed";
  if (status === "error") return "failed";
  if (status === "processing" || status === "in_progress") return "running";
  return status || "running";
}

function configuredPath(name: "CUA_IMAGE_CREATE_PATH" | "CUA_VIDEO_CREATE_PATH", fallback: string): string {
  const value = process.env[name] || fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("..")) {
    throw new PlatformError(500, { detail: `Invalid ${name}` });
  }
  return value;
}

function gatewayUrl(baseUrl: string, pathname: string): string {
  if (!pathname.startsWith("/")) throw new PlatformError(500, { detail: "Invalid Gateway path" });
  return `${baseUrl}${pathname}`;
}

function gatewayPath(baseUrl: string, value: string): string {
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("..")) return value;
  const url = new URL(value);
  const base = new URL(baseUrl);
  if (url.origin !== base.origin) {
    throw new PlatformError(502, { detail: "The Gateway returned an invalid status URL" });
  }
  const prefix = base.pathname.replace(/\/$/, "");
  const pathname = prefix && url.pathname.startsWith(`${prefix}/`)
    ? url.pathname.slice(prefix.length)
    : url.pathname;
  return `${pathname}${url.search}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function defaultMime(surface: Surface): string {
  return surface === "video" ? "video/mp4" : "image/png";
}

function messageFromBody(status: number, body: unknown): string {
  if (status === 401 || status === 403) return "Gateway authentication failed";
  if (status === 402) return "Gateway quota or balance is insufficient";
  if (status === 429) return "Gateway rate limit reached; wait and retry";
  if (status >= 500) return "The upstream generation service is unavailable";
  const data = asRecord(body);
  const nested = asRecord(data.error);
  const detail = stringField(data, "detail") ?? stringField(data, "message") ?? stringField(nested, "message");
  return detail || `Gateway request failed (${status})`;
}
