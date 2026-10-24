// Test builds only: how many times each page was read from the database.
export function GET(request: Request) {
  // Reading the request makes this route dynamic (it must not be frozen at build time).
  const reset = new URL(request.url).searchParams.has("reset");
  if (!process.env["OKS_TEST"]) return new Response("Not found", { status: 404 });
  const g = globalThis as { __oksLoads?: Record<string, number>; __oksProxyMs?: number[] };
  const body = { loads: g.__oksLoads ?? {}, proxyMs: g.__oksProxyMs ?? [] };
  if (reset) {
    g.__oksLoads = {};
    g.__oksProxyMs = [];
  }
  return Response.json(body);
}
