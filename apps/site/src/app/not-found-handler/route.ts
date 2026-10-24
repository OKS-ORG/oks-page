// What the proxy answers for an address with no published entry: a real 404 that search engines are told to ignore.
//
// Next.js replaces the cache headers a proxy sets on a route handler's response with its own, so the proxy hands the
// header it wants to this handler in a request header, and the handler sends it. Only the two known values are used,
// so a visitor who sends this header to the handler directly cannot make it say anything else.
import { NOT_FOUND_CACHE_HEADER, PRIVATE_PAGE, PUBLIC_NOT_FOUND, PRIVATE } from "../../headers";

export function GET(request: Request) {
  const wanted = request.headers.get(NOT_FOUND_CACHE_HEADER);
  const cacheControl = wanted === PUBLIC_NOT_FOUND || wanted === PRIVATE ? wanted : PRIVATE_PAGE;
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page not found</title></head><body><h1>Page not found</h1></body></html>',
    {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex",
        "cache-control": cacheControl,
      },
    },
  );
}
