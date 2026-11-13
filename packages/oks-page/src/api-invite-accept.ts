// POST /api/invite/accept: the invited person chooses a password and joins ({"token", "name", "password"}). Not behind a
// sign-in: the link itself is the right to do this, and it works once. The account is made with Better Auth, the person is
// made a member with the invited role and signed in.
import { acceptInvitation } from "@oks-page/core";
import { NextResponse } from "next/server";
import { CLIENT_HEADER, getAuth, requestOrigin } from "./auth";
import { isSameOrigin, reply } from "./api-entries";
import { USER_STATUS } from "./api-users";
import { getRunner, getSiteId } from "./db";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return reply({ code: "forbidden", message: "This request came from another address." }, 403);
  let input: Record<string, unknown>;
  try {
    input = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply({ code: "invalid", message: "The request was not understood." }, 400);
  }
  const auth = getAuth(requestOrigin(request)).auth;
  // Until trusted proxies are set up, every request counts as one client (as in the setup wizard).
  const headers = { [CLIENT_HEADER]: "unknown" };
  const password = String(input["password"] ?? "");
  const result = await acceptInvitation(
    getRunner(),
    async ({ name, email, password: chosen }) => {
      const created = await auth.api.signUpEmail!({
        body: { name, email, password: chosen },
        headers,
      });
      return { userId: String(created.user.id) };
    },
    await getSiteId(),
    String(input["token"] ?? ""),
    { name: String(input["name"] ?? ""), password },
  );
  if (!result.ok) return reply(result, USER_STATUS[result.code]);
  const signedIn: Response = await auth.api.signInEmail!({
    body: { email: result.email, password },
    asResponse: true,
    headers,
  });
  const response = NextResponse.json({ ok: true });
  for (const cookie of signedIn.headers.getSetCookie())
    response.headers.append("set-cookie", cookie);
  return response;
}
