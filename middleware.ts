import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  // Auth disabled (user requested link-only access).
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)"],
};
