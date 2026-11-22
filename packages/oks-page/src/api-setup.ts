// POST /api/setup: the last step of the setup wizard. Makes the site and the first Administrator, then signs them in.
import { runSetup, SetupError, type SetupInput } from "@oks-page/core";
import { NextResponse } from "next/server";
import { CLIENT_HEADER, getAuth, requestOrigin } from "./auth";
import { getRunner } from "./db";
import { installDefaultPlugins } from "./first-party-plugins";
import { pluginSettingsService } from "./plugin-runtime";

const STATUS = { invalid: 400, already_set_up: 409, account: 422 } as const;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || new URL(origin).host === request.headers.get("host");
}

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: { code: "forbidden", message: "This request came from another address." } },
      { status: 403 },
    );
  let input: SetupInput;
  try {
    input = (await request.json()) as SetupInput;
  } catch {
    return NextResponse.json(
      { error: { code: "invalid", message: "The request was not understood." } },
      { status: 400 },
    );
  }
  try {
    const auth = getAuth(requestOrigin(request)).auth;
    // Until trusted proxies are set up, every setup request counts as one client.
    const headers = { [CLIENT_HEADER]: "unknown" };
    const made = await runSetup(
      getRunner(),
      async ({ name, email, password }) => {
        const created = await auth.api.signUpEmail!({ body: { name, email, password }, headers });
        return { userId: String(created.user.id) };
      },
      input,
    );
    // New sites start with the Forms plugin on (spec 16). If it cannot be installed the site is still made.
    const plugins = await installDefaultPlugins(
      getRunner(),
      made.siteId,
      made.userId,
      input.admin.email.trim(),
      pluginSettingsService(),
    );
    if (!plugins.ok)
      console.error("[oks] The Forms plugin could not be installed:", plugins.message);
    const signedIn: Response = await auth.api.signInEmail!({
      body: { email: input.admin.email, password: input.admin.password },
      asResponse: true,
      headers,
    });
    const response = NextResponse.json({ ok: true });
    for (const cookie of signedIn.headers.getSetCookie())
      response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) {
    if (error instanceof SetupError)
      return NextResponse.json(
        { error: { code: error.code, field: error.field, message: error.message } },
        { status: STATUS[error.code] },
      );
    console.error("Setup failed:", error);
    return NextResponse.json(
      {
        error: {
          code: "server",
          message: error instanceof Error ? error.message : "Setup failed.",
        },
      },
      { status: 500 },
    );
  }
}
