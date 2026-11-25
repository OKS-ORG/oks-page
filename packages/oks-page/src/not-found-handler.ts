// What the proxy answers for an address with no published entry: a real 404 that search engines are told to ignore.
//
// The proxy sends this answer itself (see `notFoundResponse`). It used to rewrite to this route, and Next.js then sent the request
// to its own server over HTTP whenever it thought its own address was another one (a server started with `-H 0.0.0.0`, as in
// Docker): one more hop, which can be reset under load and then showed a visitor an error instead of the page. The route is kept
// for anyone who asks for it directly. Only the known cache values are used for a header a visitor sends to it, so a visitor
// cannot make it say anything else.
import { NextResponse } from "next/server";
import { NOT_FOUND_CACHE_HEADER, PRIVATE_PAGE, PUBLIC_NOT_FOUND, PRIVATE } from "./headers";

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page not found</title></head><body><h1>Page not found</h1></body></html>';

/** The 404 page, with the cache header the caller chose. */
export function notFoundResponse(cacheControl: string): NextResponse {
  return new NextResponse(PAGE, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
      "cache-control": cacheControl,
    },
  });
}

export function GET(request: Request) {
  const wanted = request.headers.get(NOT_FOUND_CACHE_HEADER);
  return notFoundResponse(
    wanted === PUBLIC_NOT_FOUND || wanted === PRIVATE ? wanted : PRIVATE_PAGE,
  );
}
