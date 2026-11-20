// A small stand-in for the parts of GitHub's REST API that publishing uses (git blobs, trees, commits and branches), for
// tests. The files are kept in memory as git keeps them: a branch points to a commit, a commit to a tree, a tree to blobs.
// It answers on the loopback address only. It is written from the documented API, so it is not proof that GitHub itself
// answers the same way.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const TEST_GITHUB_TOKEN = "ghp_test0123456789abcdefghijklmnopqrstuv";

export interface TestGithubServer {
  base: string;
  /** The files of a branch's newest commit, by path (text), or null when the branch does not exist. */
  files(branch: string): Map<string, string> | null;
  /** The number of commits of a branch. */
  commits(branch: string): number;
  /** Makes a branch that already holds these files and no record of an earlier publish. */
  seed(branch: string, files: Record<string, string>): void;
  /** The requests made, as `METHOD path`. */
  log: string[];
  /** Make the n-th blob request (and every later one) fail with an error. */
  failBlobsFrom(n: number | null): void;
  close(): Promise<void>;
}

const sha = (kind: string, data: Buffer | string): string => {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return createHash("sha1").update(`${kind} ${body.length}\0`).update(body).digest("hex");
};

export async function startGithubServer(
  repo = { owner: "ada", repo: "site" },
): Promise<TestGithubServer> {
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const refs = new Map<string, string>();
  const log: string[] = [];
  let blobCount = 0;
  let failFrom: number | null = null;
  const root = `/repos/${repo.owner}/${repo.repo}`;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://x");
      const method = request.method ?? "GET";
      log.push(`${method} ${url.pathname}`);
      const send = (status: number, body: unknown, raw = false) => {
        response.statusCode = status;
        response.setHeader("content-type", raw ? "text/plain" : "application/json");
        response.end(raw ? String(body) : JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${TEST_GITHUB_TOKEN}`)
        return send(401, { message: "Bad credentials" });
      if (!url.pathname.startsWith(root)) return send(404, { message: "Not Found" });
      const path = url.pathname.slice(root.length);
      let body: Record<string, unknown>;
      try {
        body = chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
          : {};
      } catch {
        return send(400, { message: "Problems parsing JSON" });
      }
      const branchOf = (p: string, prefix: string) => decodeURIComponent(p.slice(prefix.length));

      if (method === "GET" && path === "")
        return send(200, { full_name: `${repo.owner}/${repo.repo}` });
      if (method === "GET" && path.startsWith("/git/ref/heads/")) {
        const head = refs.get(branchOf(path, "/git/ref/heads/"));
        return head ? send(200, { object: { sha: head } }) : send(404, { message: "Not Found" });
      }
      if (method === "GET" && path.startsWith("/git/commits/")) {
        const c = commits.get(path.slice("/git/commits/".length));
        return c ? send(200, { tree: { sha: c.tree } }) : send(404, { message: "Not Found" });
      }
      if (method === "GET" && path.startsWith("/contents/")) {
        const head = refs.get(url.searchParams.get("ref") ?? "");
        const tree = head ? trees.get(commits.get(head)!.tree) : undefined;
        const blobSha = tree?.get(decodeURIComponent(path.slice("/contents/".length)));
        return blobSha
          ? send(200, blobs.get(blobSha)!.toString("utf8"), true)
          : send(404, { message: "Not Found" });
      }
      if (method === "POST" && path === "/git/blobs") {
        blobCount++;
        if (failFrom !== null && blobCount >= failFrom)
          return send(500, { message: "Server Error" });
        const data = Buffer.from(String(body["content"] ?? ""), "base64");
        const id = sha("blob", data);
        blobs.set(id, data);
        return send(201, { sha: id });
      }
      if (method === "POST" && path === "/git/trees") {
        const base = body["base_tree"] ? trees.get(String(body["base_tree"])) : undefined;
        if (body["base_tree"] && !base) return send(422, { message: "base tree not found" });
        const files = new Map(base ?? []);
        for (const e of (body["tree"] as { path: string; sha: string | null }[]) ?? []) {
          if (e.sha === null) files.delete(e.path);
          else if (!blobs.has(e.sha)) return send(422, { message: `blob ${e.sha} not found` });
          else files.set(e.path, e.sha);
        }
        const id = sha("tree", JSON.stringify([...files].sort()));
        trees.set(id, files);
        return send(201, { sha: id });
      }
      if (method === "POST" && path === "/git/commits") {
        const tree = String(body["tree"]);
        if (!trees.has(tree)) return send(422, { message: "tree not found" });
        const parents = (body["parents"] as string[]) ?? [];
        const id = sha("commit", JSON.stringify({ tree, parents, n: commits.size }));
        commits.set(id, { tree, parents });
        return send(201, { sha: id });
      }
      if (method === "POST" && path === "/git/refs") {
        const name = String(body["ref"]).replace(/^refs\/heads\//, "");
        if (refs.has(name)) return send(422, { message: "Reference already exists" });
        refs.set(name, String(body["sha"]));
        return send(201, { ref: body["ref"] });
      }
      if (method === "PATCH" && path.startsWith("/git/refs/heads/")) {
        const name = branchOf(path, "/git/refs/heads/");
        const current = refs.get(name);
        const next = String(body["sha"]);
        if (!current) return send(404, { message: "Not Found" });
        if (!commits.has(next)) return send(422, { message: "Object does not exist" });
        if (body["force"] !== true && !commits.get(next)!.parents.includes(current))
          return send(422, { message: "Update is not a fast forward" });
        refs.set(name, next);
        return send(200, { ref: `refs/heads/${name}` });
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    log,
    files(branch) {
      const head = refs.get(branch);
      if (!head) return null;
      const out = new Map<string, string>();
      for (const [p, id] of trees.get(commits.get(head)!.tree)!)
        out.set(p, blobs.get(id)!.toString("utf8"));
      return out;
    },
    commits(branch) {
      let n = 0;
      for (let at = refs.get(branch); at; at = commits.get(at)?.parents[0]) n++;
      return n;
    },
    seed(branch, files) {
      const map = new Map<string, string>();
      for (const [p, text] of Object.entries(files)) {
        const data = Buffer.from(text);
        const id = sha("blob", data);
        blobs.set(id, data);
        map.set(p, id);
      }
      const treeId = sha("tree", JSON.stringify([...map].sort()));
      trees.set(treeId, map);
      const commitId = sha("commit", JSON.stringify({ treeId, seed: branch }));
      commits.set(commitId, { tree: treeId, parents: [] });
      refs.set(branch, commitId);
    },
    failBlobsFrom(n) {
      failFrom = n;
      blobCount = 0;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
