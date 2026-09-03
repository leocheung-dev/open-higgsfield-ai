import { getGenerationStatuses } from "./actions";
import type { Surface } from "./catalog";
import type { GenerationStatus, StatusResult } from "./platform";

/** Statuses the platform never moves off again. */
const TERMINAL = new Set(["completed", "failed", "nsfw", "canceled"]);

export const POLL_INTERVAL_MS = 4000;
export const IMAGE_POLL_DEADLINE_MS = 10 * 60_000;
export const VIDEO_POLL_DEADLINE_MS = 30 * 60_000;
const MIN_POLL_DEADLINE_MS = 30_000;
/** Rounds allowed to fail back to back before the watches are given up on. One
    dropped round must not end every generation in flight. */
const MAX_MISSES = 3;

type Waiter = {
  deadline: number;
  resolve: (status: GenerationStatus) => void;
  reject: (reason: Error) => void;
};

export class BrowserPollDeadlineError extends Error {
  constructor() {
    super("Local polling window elapsed; the remote generation may still be running");
    this.name = "BrowserPollDeadlineError";
  }
}

export function isBrowserPollDeadlineError(value: unknown): value is BrowserPollDeadlineError {
  return value instanceof BrowserPollDeadlineError;
}

/** Browser-side polling is deliberately bounded without imposing a provider
    cancellation. Videos take longer by default, and both windows may be
    adjusted at build time with public Studio-only environment variables. */
export function pollDeadlineFor(surface: Surface, configured?: string | undefined): number {
  const fallback = surface === "video" ? VIDEO_POLL_DEADLINE_MS : IMAGE_POLL_DEADLINE_MS;
  const value = Number(configured);
  return Number.isFinite(value) && value >= MIN_POLL_DEADLINE_MS ? value : fallback;
}

function configuredDeadline(surface: Surface): number {
  return pollDeadlineFor(
    surface,
    surface === "video"
      ? process.env.NEXT_PUBLIC_CUA_VIDEO_POLL_DEADLINE_MS
      : process.env.NEXT_PUBLIC_CUA_IMAGE_POLL_DEADLINE_MS,
  );
}

const waiting = new Map<string, Waiter>();
const inflight = new Map<string, Promise<GenerationStatus>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let misses = 0;

/** Resolves when the platform reports a terminal status for this request.
    Every request in flight is asked for together, in one server action per
    interval: Next dispatches server actions one at a time per client, so a
    poll per run would queue ahead of the next submit and the composer would
    stall again — with the lock gone and the queue doing the same work. */
export function watchRequest(
  requestId: string,
  opts?: { deadline?: number; surface?: Surface },
): Promise<GenerationStatus> {
  const existing = inflight.get(requestId);
  if (existing) return existing;
  const promise = new Promise<GenerationStatus>((resolve, reject) => {
    waiting.set(requestId, {
      deadline: opts?.deadline ?? Date.now() + configuredDeadline(opts?.surface ?? "image"),
      resolve: (status) => {
        inflight.delete(requestId);
        resolve(status);
      },
      reject: (reason) => {
        inflight.delete(requestId);
        reject(reason);
      },
    });
    schedule();
  });
  inflight.set(requestId, promise);
  return promise;
}

/** Drops every watch without settling it: the studio unmounted and there is
    nobody left to hand a result to. In-flight jobs stay in history and the
    next mount starts a fresh watch. */
export function stopWatching(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  misses = 0;
  waiting.clear();
  inflight.clear();
}

function schedule(): void {
  if (timer !== null || polling || waiting.size === 0) return;
  timer = setTimeout(() => void round(), POLL_INTERVAL_MS);
}

async function round(): Promise<void> {
  timer = null;
  polling = true;
  try {
    const results = await getGenerationStatuses({ requestIds: [...waiting.keys()] });
    misses = 0;
    for (const result of results) deliver(result);
    sweep();
  } catch (caught) {
    if (++misses < MAX_MISSES) return;
    settleAll(caught instanceof Error ? caught : new Error(String(caught)));
  } finally {
    polling = false;
    schedule();
  }
}

function deliver(result: StatusResult): void {
  const waiter = waiting.get(result.requestId);
  if (!waiter) return;
  if ("error" in result) {
    waiting.delete(result.requestId);
    waiter.reject(new Error(result.error));
    return;
  }
  if (!TERMINAL.has(result.status.status)) return;
  waiting.delete(result.requestId);
  waiter.resolve(result.status);
}

/* A run the platform never finishes would otherwise hold its skeleton open for
   the rest of the browser session. This is a local waiting limit only: the
   persisted request id remains available for the next reload to resume. */
function sweep(): void {
  const now = Date.now();
  for (const [requestId, waiter] of [...waiting]) {
    if (now <= waiter.deadline) continue;
    waiting.delete(requestId);
    waiter.reject(new BrowserPollDeadlineError());
  }
}

function settleAll(reason: Error): void {
  const waiters = [...waiting.values()];
  waiting.clear();
  misses = 0;
  for (const waiter of waiters) waiter.reject(reason);
}
