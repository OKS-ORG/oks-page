// /admin/reset-password?token=…: choose a new password from the link in the email (spec 02; spec 13).
import { isSetupDone } from "@oks-page/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getRunner } from "./db";
import { ResetPasswordForm } from "./password-reset-forms";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false },
  // The link carries a secret: it must not be passed on to other sites.
  referrer: "no-referrer",
};

type Props = { searchParams: Promise<{ token?: string }> };

export default async function ResetPasswordPage({ searchParams }: Props) {
  await connection();
  if (!(await isSetupDone(getRunner()))) redirect("/admin/setup");
  const token = (await searchParams).token;
  return (
    <main>
      <h1>Choose a new password</h1>
      {typeof token === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(token) ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p>
          This link is not complete. Open the link from the email again, or{" "}
          <a href="/admin/forgot-password">ask for a new one</a>.
        </p>
      )}
    </main>
  );
}
