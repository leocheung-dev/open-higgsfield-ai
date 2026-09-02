import { imageModel } from "./defaults";

export const gptImage2 = imageModel("gpt-image-2", "GPT Image 2", {
  text: "openai/gpt-image-2",
});

gptImage2.gatewayIds = ["gpt-image-2", "gpt-image-1"];
