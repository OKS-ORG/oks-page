// /admin/forgot-password: ask for a link to choose a new password (spec 02; spec 13). Only when email works; otherwise
// it says how else to get back in (another administrator, or `oks user reset` on the server).
import { emailWorks, isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getRunner, getSiteId } from "./db";
import { ForgotPasswordForm } from "./password-reset-forms";

export const metadata: Metadata = { title: "Forgot your password?", robots: { index: false } };

export default async function ForgotPasswordPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const works = await emailWorks(getRunner(), await getSiteId());
  return (
    <main>
      <h1>Forgot your password?</h1>
      {works ? (
        <ForgotPasswordForm />
      ) : (
        <p>
          This site cannot send email yet, so a new password cannot be sent by email. Ask an
          administrator of the site to help you, or, if you run the server, use the command{" "}
          <code>oks user reset</code>.
        </p>
      )}
      <p>
        <a href="/admin/login">Back to sign in</a>
      </p>
    </main>
  );
}
