export async function uploadMedia(file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/cua/uploads", {
    method: "POST",
    body: form,
  });
  const payload = (await res.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
  if (!res.ok || typeof payload?.url !== "string") {
    throw new Error(typeof payload?.error === "string" ? payload.error : "Upload failed");
  }
  return { url: payload.url };
}
