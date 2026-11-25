// /collect/<token>: the page a client opens from the link an agency gave them (spec 11, section 8). It needs no account. It says
// what the link is for and what it takes, or, for a wrong, turned-off or expired link, says so in plain words. It is never cached or
// indexed, and the link is not passed on in a Referer header.
import { openCollectLink } from "@oks-page/core";
import type { Metadata } from "next";
import { connection } from "next/server";
import { CollectForm } from "./collect-form";
import { getRunner } from "./db";

export const metadata: Metadata = {
  title: "Send your content",
  robots: { index: false },
  referrer: "no-referrer",
};

const MAIN = {
  maxInlineSize: "40rem",
  margin: "4rem auto",
  padding: "0 1rem",
  fontFamily: "system-ui, sans-serif",
} as const;

export default async function CollectPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  let opened;
  try {
    opened = await openCollectLink(getRunner(), token);
  } catch {
    opened = {
      ok: false as const,
      reason: "unknown" as const,
      message: "This link does not work.",
    };
  }
  if (!opened.ok)
    return (
      <main style={MAIN}>
        <h1>Send your content</h1>
        <p role="alert">{opened.message}</p>
      </main>
    );
  const link = opened.link;
  return (
    <main style={MAIN}>
      <h1>Send your content</h1>
      <p>
        <strong>{link.label}</strong>
      </p>
      {link.note ? <p style={{ whiteSpace: "pre-line" }}>{link.note}</p> : null}
      <p>
        Whatever you send here is seen only by the people who look after the site. Nothing is
        published until they choose to.
      </p>
      <CollectForm
        token={token}
        filesLeft={Math.max(0, link.maxFiles - link.usedFiles)}
        megabytesLeft={Math.max(0, Math.floor((link.maxBytes - link.usedBytes) / (1024 * 1024)))}
        textLeft={Math.max(0, link.maxText - link.usedText)}
      />
    </main>
  );
}
