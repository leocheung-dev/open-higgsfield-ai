import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { DEVICE_COOKIE, DEVICE_COOKIE_OPTIONS, resolveDeviceId } from "./generation/device";

export function proxy(request: NextRequest) {
  if (process.env.CUA_ALLOW_REMOTE !== "1" && !hasOnlyLoopbackHosts(request)) {
    return NextResponse.json(
      { error: "This CUA service only accepts local connections" },
      { status: 403 },
    );
  }

  const { deviceId, minted } = resolveDeviceId(request.cookies.get(DEVICE_COOKIE)?.value);
  if (!minted) return NextResponse.next();
  const response = NextResponse.next();
  response.cookies.set(DEVICE_COOKIE, deviceId, DEVICE_COOKIE_OPTIONS);
  return response;
}

function hasOnlyLoopbackHosts(request: NextRequest): boolean {
  const values = [request.headers.get("host"), request.headers.get("x-forwarded-host")].filter(
    (value): value is string => Boolean(value),
  );
  return values.length > 0 && values.every((value) => isLoopbackHost(hostnameFromHeader(value)));
}

function hostnameFromHeader(value: string): string {
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":", 1)[0] ?? "";
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
