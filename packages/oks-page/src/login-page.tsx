// /admin/login: the sign-in page. A signed-in member goes straight to the dashboard; a new install goes to the wizard.
import { emailWorks, isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { signedInMember } from "./admin-session";
import { getRunner, getSiteId } from "./db";
import { LoginForm } from "./login-form";
import { SignInLinkForm } from "./sign-in-link-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

type Props = { searchParams: Promise<{ link?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  // An administrator who must still set up two-factor (the site's rule) goes to their account screen to do it.
  const member = await signedInMember({ allowSetup: true });
  if (member) redirect(member.mustSetUpTwoFactor ? "/admin/account" : "/admin");
  const email = await emailWorks(getRunner(), await getSiteId());
  const failed = (await searchParams).link === "failed";
  return (
    <main>
      <h1>Sign in</h1>
      <LoginForm />
      {email ? (
        <>
          <p>
            <a href="/admin/forgot-password">Forgot your password?</a>
          </p>
          <SignInLinkForm failed={failed} />
        </>
      ) : null}
    </main>
  );
}
