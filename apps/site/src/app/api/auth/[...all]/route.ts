// The sign-in routes of Better Auth (sessions, sign-in, sign-out). Not part of an export.
import { getAuth } from "../../../../auth";

const handle = (request: Request) =>
  // No socket address is available here, so the client counts as "unknown" until trusted proxies are set up.
  getAuth(new URL(request.url).origin).handler(request, {});

export { handle as GET, handle as POST };
