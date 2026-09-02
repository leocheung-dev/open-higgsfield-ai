"use server";

import { createHash } from "node:crypto";

import { getModel, parseSettings } from "./catalog";
import { MODELS } from "./catalog";
import type { GenerationPlane } from "./catalog/types";
import { MissingCredentialsError } from "./credentials";
import {
  availableCatalogModels,
  fetchGatewayModelIds,
  resolveGatewayModelId,
  type GatewayCredentials,
} from "./gateway-models";
import { createPlatformClient } from "./platform";
import { PlatformError } from "./platform";
import type { StatusResult } from "./platform";
import { toPlatform } from "./to-platform";

const MODEL_CACHE_TTL_MS = 30_000;

let modelCache:
  | { credentialId: string; expiresAt: number; modelIds: string[] }
  | undefined;

export type AvailableModelsResult =
  | { status: "ready"; modelIds: string[] }
  | { status: "error"; modelIds: []; message: string };

export async function listAvailableModels(): Promise<AvailableModelsResult> {
  try {
    const modelIds = await discoverGatewayModels(readCredentials());
    return {
      status: "ready",
      modelIds: availableCatalogModels(MODELS, modelIds).map((model) => model.id),
    };
  } catch (caught) {
    return {
      status: "error",
      modelIds: [],
      message:
        caught instanceof MissingCredentialsError
          ? "The local Gateway is not configured. Check the server environment and restart."
          : "The Gateway model list is unavailable. Check the Gateway connection and try again.",
    };
  }
}

export async function submitGeneration(plane: GenerationPlane) {
  const model = getModel(plane.model);
  const parsed: GenerationPlane = {
    ...plane,
    settings: parseSettings(model, plane.settings),
  };
  const { path, body } = toPlatform(parsed);
  const credentials = readCredentials();
  const gatewayModels = await discoverGatewayModels(credentials);
  const gatewayModel = resolveGatewayModelId(model, gatewayModels);
  if (!gatewayModel) {
    throw new PlatformError(403, { detail: "The selected model is not available for this Gateway key" });
  }
  return createPlatformClient(credentials).submit(path, body, {
    model: gatewayModel,
    surface: model.surface,
  });
}

/** Every request in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call, where it is
    genuinely parallel. */
export async function getGenerationStatuses(data: unknown): Promise<StatusResult[]> {
  const requestIds = parseRequestIds(data);
  const client = createPlatformClient(readCredentials());
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await client.status(requestId) };
      } catch (caught) {
        return { requestId, error: caught instanceof Error ? caught.message : String(caught) };
      }
    }),
  );
}

function readCredentials() {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!apiKey || !baseUrl) throw new MissingCredentialsError();
  return { apiKey, baseUrl };
}

async function discoverGatewayModels(credentials: GatewayCredentials): Promise<string[]> {
  const credentialId = createHash("sha256")
    .update(credentials.baseUrl)
    .update("\0")
    .update(credentials.apiKey)
    .digest("hex");
  if (
    modelCache &&
    modelCache.credentialId === credentialId &&
    modelCache.expiresAt > Date.now()
  ) {
    return modelCache.modelIds;
  }
  const modelIds = await fetchGatewayModelIds(credentials);
  modelCache = {
    credentialId,
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    modelIds,
  };
  return modelIds;
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload");
  const requestIds = payload.requestIds;
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("Invalid request ids");
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new Error("Invalid request id");
    return requestId;
  });
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message);
  return data as Record<string, unknown>;
}
