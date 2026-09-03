import type { ModelEntry } from "./types";
import { BANANA_ASPECT } from "./tokens";

export const nanoBanana2: ModelEntry = {
  id: "nano-banana-2",
  gatewayIds: ["gemini-3.1-flash-image", "gemini-2.5-flash-image"],
  surface: "image",
  label: "Nano Banana 2",
  roles: { reference: 14 },
  settings: {
    aspectRatio: { type: "enum", values: BANANA_ASPECT, default: "4:3" },
    resolution: { type: "enum", values: ["1k", "2k", "4k"], default: "1k" },
    outputFormat: { type: "enum", values: ["png", "jpeg"], default: "png" },
  },
};
