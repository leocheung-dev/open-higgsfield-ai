export class MissingCredentialsError extends Error {
  constructor() {
    super("The local Gateway is not configured");
    this.name = "MissingCredentialsError";
  }
}

export function toAuthorizationHeader(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("Missing OPENAI_API_KEY");
  return `Bearer ${trimmed}`;
}
