import type { ModelEntry } from "./catalog/types";
import { toAuthorizationHeader } from "./credentials";

const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;

export type GatewayCredentials = {
  apiKey: string;
  baseUrl: string;
};

export async function fetchGatewayModelIds(
  credentials: GatewayCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const endpoint = `${credentials.baseUrl.replace(/\/$/, "")}/models`;
  const response = await fetchImpl(endpoint, {
    headers: { Authorization: toAuthorizationHeader(credentials.apiKey) },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (body.length > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error("Gateway model response is too large");
  }
  if (!response.ok) throw new Error(`Gateway model discovery returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Gateway model discovery returned invalid JSON");
  }
  return parseGatewayModelIds(payload);
}

export function parseGatewayModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Gateway model discovery returned an invalid response");
  }
  const seen = new Set<string>();
  for (const item of payload.data) {
    const id =
      typeof item === "string"
        ? item.trim()
        : isRecord(item) && typeof item.id === "string"
          ? item.id.trim()
          : "";
    if (id && isModelId(id)) seen.add(id);
  }
  return [...seen];
}

export function availableCatalogModels(
  catalog: readonly ModelEntry[],
  gatewayModelIds: readonly string[],
): ModelEntry[] {
  const available = new Set(gatewayModelIds);
  return catalog.filter((model) => gatewayIdsFor(model).some((id) => available.has(id)));
}

export function resolveGatewayModelId(
  model: ModelEntry,
  gatewayModelIds: readonly string[],
): string | undefined {
  const available = new Set(gatewayModelIds);
  return gatewayIdsFor(model).find((id) => available.has(id));
}

function gatewayIdsFor(model: ModelEntry): readonly string[] {
  return model.gatewayIds?.length ? model.gatewayIds : [model.id];
}

function isModelId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(value) && !value.includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
