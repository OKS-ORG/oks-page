// What the proxy answers for an address with no published entry: a real 404 that search engines are told to ignore.
export function GET() {
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page not found</title></head><body><h1>Page not found</h1></body></html>',
    {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex",
        "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
      },
    },
  );
}
