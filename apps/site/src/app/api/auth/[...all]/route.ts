// The sign-in routes of Better Auth (sessions, sign-in, sign-out). Not part of an export.
import { getAuth } from "../../../../auth";

async function handle(request: Request) {
  // Next.js gives a request of its own kind. Node 24 and 26 refuse to copy such a request ("Cannot read private member
  // #state"), and the auth wrapper copies it, so it is rebuilt here as a plain standard request first.
  const plain = new Request(request.url, {
    method: request.method,
    headers: [...request.headers],
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
  });
  // No socket address is available here, so the client counts as "unknown" until trusted proxies are set up.
  return getAuth(new URL(request.url).origin).handler(plain, {});
}

export { handle as GET, handle as POST };
