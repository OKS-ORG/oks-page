// A place to publish to on GitHub Pages (spec 10, section 7.2): the site is committed to a branch of a repository that
// Pages serves. Everything is sent to GitHub as blobs, but nothing becomes visible until the last step moves the branch to
// the new commit, so a visitor sees the old site or the new one, never a mixture, and a publish that is cut off leaves the
// site as it was. The token only goes to GitHub's own address.
import { MANIFEST_FILE, isSafePath, type Manifest, type PublishTarget } from "./publish.js";

export const GITHUB_API = "https://api.github.com";

export interface GithubOptions {
  owner: string;
  repo: string;
  branch: string;
  /** A token that may write the repository's contents. */
  token: string;
  /** For tests and for GitHub Enterprise: the address of the API. */
  apiBase?: string;
  /** How long to wait for one answer, in milliseconds. */
  timeoutMs?: number;
}

/** What went wrong, in plain words, from GitHub's answer. */
export function plainGithubError(
  status: number,
  message: string,
  o: { owner: string; repo: string },
): string {
  if (status === 401) return "GitHub refused the token. It may be wrong, expired or taken back.";
  if (status === 403 && /rate limit/i.test(message))
    return "GitHub says too many requests were made. Wait a while and publish again.";
  if (status === 403)
    return "GitHub did not allow that. The token needs permission to write the contents of the repository.";
  if (status === 404)
    return `GitHub could not find ${o.owner}/${o.repo}, or the token has no access to it.`;
  if (status === 409 || status === 422)
    return `GitHub refused the change: ${message.slice(0, 160)}`;
  return `GitHub answered with an error (${status}): ${message.slice(0, 160)}`;
}

/** A place on GitHub Pages. Files are sent as the publish goes; the branch moves only at the end. */
export function githubPagesTarget(o: GithubOptions): PublishTarget {
  const base = (o.apiBase ?? GITHUB_API).replace(/\/+$/, "");
  const repoUrl = `${base}/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}`;
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  let parent: { commit: string; tree: string } | null | undefined;
  let previousManifest: Manifest | null = null;

  async function api(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    let response: Response;
    try {
      response = await fetch(`${repoUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
        headers: {
          authorization: `Bearer ${o.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "oks-page-publish",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...extra,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new Error("GitHub could not be reached.", { cause: error });
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  const fail = (status: number, json: unknown, text: string): never => {
    const message = (json as { message?: unknown } | null)?.message;
    throw new Error(plainGithubError(status, typeof message === "string" ? message : text, o));
  };

  /** The commit the branch points to now (and its tree), or null when the branch does not exist yet. */
  async function head(): Promise<{ commit: string; tree: string } | null> {
    if (parent !== undefined) return parent;
    const ref = await api(
      "GET",
      `/git/ref/heads/${o.branch.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (ref.status === 404) {
      // The branch may be missing, or the repository (or the token's access to it).
      const repo = await api("GET", "");
      if (repo.status !== 200) fail(repo.status, repo.json, repo.text);
      parent = null;
      return null;
    }
    if (ref.status !== 200) fail(ref.status, ref.json, ref.text);
    const commit = (ref.json as { object?: { sha?: string } }).object?.sha ?? "";
    const c = await api("GET", `/git/commits/${commit}`);
    if (c.status !== 200) fail(c.status, c.json, c.text);
    parent = { commit, tree: (c.json as { tree?: { sha?: string } }).tree?.sha ?? "" };
    return parent;
  }

  async function blob(bytes: Buffer): Promise<string> {
    const r = await api("POST", "/git/blobs", {
      content: bytes.toString("base64"),
      encoding: "base64",
    });
    if (r.status !== 201) fail(r.status, r.json, r.text);
    return String((r.json as { sha?: string }).sha);
  }

  return {
    async previous() {
      const at = await head();
      if (!at) return null;
      const r = await api(
        "GET",
        `/contents/${MANIFEST_FILE}?ref=${encodeURIComponent(o.branch)}`,
        undefined,
        { accept: "application/vnd.github.raw+json" },
      );
      if (r.status === 404) return null;
      if (r.status !== 200) fail(r.status, r.json, r.text);
      try {
        const m = JSON.parse(r.text) as Manifest;
        previousManifest = m.v === 1 && m.files && typeof m.files === "object" ? m : null;
      } catch {
        previousManifest = null;
      }
      return previousManifest;
    },
    async put(path, bytes) {
      if (!isSafePath(path)) throw new Error(`"${path}" is not a safe file name`);
      entries.push({ path, mode: "100644", type: "blob", sha: await blob(bytes) });
    },
    async remove(path) {
      if (!isSafePath(path)) throw new Error(`"${path}" is not a safe file name`);
      entries.push({ path, mode: "100644", type: "blob", sha: null });
    },
    async finish(manifest) {
      // Nothing changed since the last publish: there is nothing to commit.
      if (entries.length === 0 && previousManifest) return;
      const at = await head();
      // GitHub Pages runs Jekyll unless this file is there, and Jekyll hides every folder that starts with an underscore
      // (the `_next` folder of the site would be gone).
      if (!previousManifest || !(".nojekyll" in (previousManifest.files ?? {})))
        entries.push({
          path: ".nojekyll",
          mode: "100644",
          type: "blob",
          sha: await blob(Buffer.alloc(0)),
        });
      entries.push({
        path: MANIFEST_FILE,
        mode: "100644",
        type: "blob",
        sha: await blob(Buffer.from(JSON.stringify(manifest))),
      });
      const tree = await api("POST", "/git/trees", {
        // Only a branch that this place published to is built on: another one is replaced, not mixed with.
        ...(at && previousManifest ? { base_tree: at.tree } : {}),
        tree: entries,
      });
      if (tree.status !== 201) fail(tree.status, tree.json, tree.text);
      const commit = await api("POST", "/git/commits", {
        message: "Publish the site",
        tree: (tree.json as { sha?: string }).sha,
        parents: at ? [at.commit] : [],
      });
      if (commit.status !== 201) fail(commit.status, commit.json, commit.text);
      const sha = (commit.json as { sha?: string }).sha;
      // The one step that changes what visitors see.
      const moved = at
        ? await api(
            "PATCH",
            `/git/refs/heads/${o.branch.split("/").map(encodeURIComponent).join("/")}`,
            {
              sha,
              force: false,
            },
          )
        : await api("POST", "/git/refs", { ref: `refs/heads/${o.branch}`, sha });
      if (moved.status !== 200 && moved.status !== 201) fail(moved.status, moved.json, moved.text);
    },
  };
}
