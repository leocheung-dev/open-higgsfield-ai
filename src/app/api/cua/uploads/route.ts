import { NextResponse } from "next/server";

import { saveUpload } from "@/generation/local-files";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Select a file to upload" }, { status: 400 });
    }
    return NextResponse.json(await saveUpload(file), { status: 201 });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
