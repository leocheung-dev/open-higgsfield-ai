import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createPlatformClient, messageFromBody } from "./platform";

test("Gateway 402 copy identifies Pine Credits without exposing USD or quota", () => {
  const message = messageFromBody(402, { detail: "ignored provider detail" });
  assert.match(message, /Pine Credits/);
  assert.doesNotMatch(message, /\bUSD\b|\$|quota/i);
});

test("Gemini image models use Chat Completions and materialize inline image output", async (t) => {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: `Generated image:\n![result](data:image/png;base64,${pngBase64})` } }],
    }));
  }) as typeof fetch;

  const client = createPlatformClient({
    apiKey: "pmk_test",
    baseUrl: "https://gateway.example/v1",
    fetch: fetchImpl,
  });
  const queued = await client.submit("ignored", { prompt: "draw a pine tree" }, {
    model: "gemini-2.5-flash-image",
    surface: "image",
  });
  const status = await client.status(queued.requestId);
  const outputUrl = status.images?.[0]?.url;

  assert.equal(requestUrl, "https://gateway.example/v1/chat/completions");
  assert.deepEqual(requestBody, {
    model: "gemini-2.5-flash-image",
    messages: [{ role: "user", content: "draw a pine tree" }],
    stream: false,
  });
  assert.equal(status.status, "completed");
  assert.match(outputUrl ?? "", /^\/api\/cua\/outputs\/[a-f0-9]{32}\.png$/);

  const outputName = outputUrl?.split("/").at(-1);
  if (outputName) {
    t.after(async () => unlink(path.join(process.cwd(), "outputs", outputName)).catch(() => undefined));
  }
  t.after(async () =>
    unlink(path.join(process.cwd(), "runtime", "requests", `${queued.requestId}.json`)).catch(() => undefined),
  );
});
