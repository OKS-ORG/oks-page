// /admin/invite/[token]: where an invited person lands from their link. Not behind a sign-in. A link that is wrong, used,
// cancelled or expired gets one plain message, so nobody can tell which it was.
import { isSetupDone, loadGeneralSettings, readInvitation } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getRunner, getSiteId } from "./db";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = {
  title: "Join the site",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const { token } = await params;
  const siteId = await getSiteId();
  const invitation = await readInvitation(getRunner(), siteId, token);
  if (!invitation)
    return (
      <main>
        <h1>This invitation cannot be used</h1>
        <p>It may have expired, or it was already used to create an account.</p>
        <div className="oks-entry-warn">
          <strong>The link is no longer valid.</strong>
          <span>Ask the person who invited you to send a new one.</span>
        </div>
        <div className="oks-entry-go">
          <a className="oks-link-button oks-link-main" href="/admin/login">
            Go to sign in
          </a>
        </div>
      </main>
    );
  const { siteName } = await loadGeneralSettings(getRunner(), siteId);
  return (
    <main>
      <h1>You are invited</h1>
      <p>
        You are invited to join {siteName} as {invitation.roleLabel}. Choose a password to start.
      </p>
      <InviteForm token={token} name={invitation.name} email={invitation.email} />
    </main>
  );
}
