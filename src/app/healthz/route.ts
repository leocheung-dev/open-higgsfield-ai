import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok", version: "0.2.0" },
    { headers: { "cache-control": "no-store" } },
  );
}
