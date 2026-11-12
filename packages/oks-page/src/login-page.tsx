// /admin/login: the sign-in page. A signed-in member goes straight to the dashboard; a new install goes to the wizard.
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { signedInMember } from "./admin-session";
import { getRunner } from "./db";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function LoginPage() {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  // An administrator who must still set up two-factor (the site's rule) goes to their account screen to do it.
  const member = await signedInMember({ allowSetup: true });
  if (member) redirect(member.mustSetUpTwoFactor ? "/admin/account" : "/admin");
  return (
    <main>
      <h1>Sign in</h1>
      <LoginForm />
    </main>
  );
}
