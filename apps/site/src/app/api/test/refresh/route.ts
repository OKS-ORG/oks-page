// Test builds only: refresh cached pages the way a publish does.
import { revalidatePath, revalidateTag } from "next/cache";

export async function POST(request: Request) {
  if (!process.env["OKS_TEST"]) return new Response("Not found", { status: 404 });
  const { tag, mode, path } = (await request.json()) as {
    tag?: string;
    mode?: "max" | "expire0";
    path?: string;
  };
  if (tag) revalidateTag(tag, mode === "expire0" ? { expire: 0 } : "max");
  if (path) revalidatePath(path);
  return Response.json({ ok: true });
}
