import { NextResponse } from "next/server";

import { readLocalFile } from "@/generation/local-files";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await context.params;
  const file = await readLocalFile("outputs", name);
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
