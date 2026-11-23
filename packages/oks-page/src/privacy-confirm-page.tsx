// /privacy-request/confirm/<token>: the link in the confirmation email. It only shows a button; see privacy-confirm-button.tsx.
import type { Metadata } from "next";
import { connection } from "next/server";
import { PrivacyConfirmButton } from "./privacy-confirm-button";

export const metadata: Metadata = {
  title: "Confirm your request",
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function PrivacyConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await connection();
  const { token } = await params;
  return (
    <main
      style={{
        maxInlineSize: "40rem",
        margin: "4rem auto",
        padding: "0 1rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Confirm your request</h1>
      <p>
        You asked about the personal data this site keeps about you. To make sure the request is
        yours, please confirm it here. Nothing is sent or deleted before you do.
      </p>
      <PrivacyConfirmButton token={token} />
      <p>
        <a href="/">Back to the site</a>
      </p>
    </main>
  );
}
