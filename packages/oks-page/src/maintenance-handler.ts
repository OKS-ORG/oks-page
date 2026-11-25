// What the proxy shows visitors while maintenance mode is on (it sends this answer itself, see `maintenanceResponse`; the route is kept
// for anyone who asks for it directly): a plain page with the owner's message, status 503 (so
// search engines come back later and do not drop the pages) and a Retry-After of one hour. Never cached by a CDN.
import { connection, NextResponse } from "next/server";
import { maintenanceSettings } from "./settings";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The 503 page with the owner's message. */
export function maintenanceResponse(message: string): NextResponse {
  const paragraphs = message
    .split(/\n+/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Back soon</title></head><body><main><h1>Back soon</h1>${paragraphs}</main></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex",
        "retry-after": "3600",
        "cache-control": "private, no-store",
      },
    },
  );
}

export async function GET() {
  // Read the setting on every request, never while the site is built.
  await connection();
  const { message } = await maintenanceSettings();
  return maintenanceResponse(message);
}
