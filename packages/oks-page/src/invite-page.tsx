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
        <h1>This invitation link does not work</h1>
        <p>
          The link may have been used already, cancelled, or it may have expired. Ask the person who
          invited you for a new one.
        </p>
        <p>
          <a href="/admin/login">Sign in</a> if you already have an account.
        </p>
      </main>
    );
  const { siteName } = await loadGeneralSettings(getRunner(), siteId);
  return (
    <main>
      <h1>Join {siteName}</h1>
      <p>
        You are invited as <strong>{invitation.roleLabel}</strong>. Choose a password to finish.
      </p>
      <InviteForm token={token} name={invitation.name} email={invitation.email} />
    </main>
  );
}
