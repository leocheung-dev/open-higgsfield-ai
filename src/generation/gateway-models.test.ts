import assert from "node:assert/strict";
import test from "node:test";

import type { ModelEntry } from "./catalog/types";
import {
  availableCatalogModels,
  fetchGatewayModelIds,
  parseGatewayModelIds,
  resolveGatewayModelId,
} from "./gateway-models";

function model(id: string, gatewayIds?: readonly string[]): ModelEntry {
  return { id, gatewayIds, label: id, surface: "image", roles: {}, settings: {} };
}

test("parses and deduplicates OpenAI-compatible model lists", () => {
  assert.deepEqual(
    parseGatewayModelIds({
      object: "list",
      data: [{ id: "gpt-image-1" }, { id: "gpt-image-1" }, "kling-3", { id: "../bad" }],
    }),
    ["gpt-image-1", "kling-3"],
  );
  assert.throws(() => parseGatewayModelIds({ data: null }), /invalid response/);
});

test("filters the local catalog and resolves aliases in preference order", () => {
  const catalog = [
    model("gpt-image-2", ["gpt-image-2", "gpt-image-1"]),
    model("kling-3"),
    model("unavailable"),
  ];
  assert.deepEqual(
    availableCatalogModels(catalog, ["gpt-image-1", "kling-3"]).map((entry) => entry.id),
    ["gpt-image-2", "kling-3"],
  );
  assert.equal(resolveGatewayModelId(catalog[0]!, ["gpt-image-1"]), "gpt-image-1");
  assert.equal(
    resolveGatewayModelId(catalog[0]!, ["gpt-image-1", "gpt-image-2"]),
    "gpt-image-2",
  );
  assert.equal(resolveGatewayModelId(catalog[2]!, ["gpt-image-1"]), undefined);
});

test("discovers models server-side with the Gateway bearer credential", async () => {
  let requestUrl = "";
  let authorization = "";
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-image-1" }] }));
  }) as typeof fetch;

  const ids = await fetchGatewayModelIds(
    { apiKey: "pmk_test_gateway_discovery", baseUrl: "https://gateway.example/v1/" },
    fetchImpl,
  );
  assert.deepEqual(ids, ["gpt-image-1"]);
  assert.equal(requestUrl, "https://gateway.example/v1/models");
  assert.equal(authorization, "Bearer pmk_test_gateway_discovery");
});

test("fails closed when Gateway model discovery fails", async () => {
  const fetchImpl = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  await assert.rejects(
    fetchGatewayModelIds(
      { apiKey: "pmk_test_gateway_discovery", baseUrl: "https://gateway.example/v1" },
      fetchImpl,
    ),
    /HTTP 503/,
  );
});
