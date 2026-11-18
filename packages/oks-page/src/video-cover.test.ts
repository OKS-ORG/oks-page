// How the server fetches the picture of a video (PB-94): only the two companies' fixed picture addresses, one request each,
// and anything unexpected gives no picture instead of an error.
import type { VideoSource } from "@oks-page/core";
import { describe, expect, test } from "vitest";
import { fetchVideoCover } from "./video-cover";

const youtube: VideoSource = {
  company: "YouTube",
  id: "dQw4w9WgXcQ",
  player: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  watch: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
};
const vimeo: VideoSource = {
  company: "Vimeo",
  id: "123456789",
  player: "https://player.vimeo.com/video/123456789",
  watch: "https://vimeo.com/123456789",
};

const picture = (type = "image/jpeg", size = 10, status = 200) =>
  new Response(new Uint8Array(size).fill(1), { status, headers: { "content-type": type } });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A fake network that records every address asked for. */
const network = (answers: Record<string, () => Response | Promise<Response>>) => {
  const asked: string[] = [];
  const fetcher = async (url: string) => {
    asked.push(url);
    const answer = answers[new URL(url).hostname];
    if (!answer) throw new Error(`no answer for ${url}`);
    return answer();
  };
  return { asked, fetcher };
};

describe("fetchVideoCover", () => {
  test("a YouTube picture comes from the company's picture host, with one request", async () => {
    const net = network({ "i.ytimg.com": () => picture() });
    const got = await fetchVideoCover(youtube, net.fetcher);
    expect(got?.extension).toBe("jpg");
    expect(got?.bytes.length).toBe(10);
    expect(net.asked).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]);
  });

  test("a Vimeo picture is found through the company's answer, and only from its own picture host", async () => {
    const good = network({
      "vimeo.com": () => json({ thumbnail_url: "https://i.vimeocdn.com/video/1_640.jpg" }),
      "i.vimeocdn.com": () => picture("image/webp"),
    });
    expect((await fetchVideoCover(vimeo, good.fetcher))?.extension).toBe("webp");
    expect(good.asked.map((u) => new URL(u).hostname)).toEqual(["vimeo.com", "i.vimeocdn.com"]);
    const evil = network({
      "vimeo.com": () => json({ thumbnail_url: "https://evil.test/x.jpg" }),
      "evil.test": () => picture(),
    });
    expect(await fetchVideoCover(vimeo, evil.fetcher)).toBeNull();
    expect(evil.asked).toHaveLength(1);
    const plain = network({
      "vimeo.com": () => json({ thumbnail_url: "http://i.vimeocdn.com/x.jpg" }),
    });
    expect(await fetchVideoCover(vimeo, plain.fetcher)).toBeNull();
  });

  test("anything unexpected gives no picture: a failure, a redirect, another type, too big, empty, no network", async () => {
    const cases: Record<string, () => Response | Promise<Response>> = {
      "not found": () => picture("image/jpeg", 10, 404),
      redirect: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
      "a web page": () => picture("text/html"),
      "an svg": () => picture("image/svg+xml"),
      "too big": () => picture("image/jpeg", 2_000_001),
      empty: () => picture("image/jpeg", 0),
      "network down": () => {
        throw new Error("down");
      },
    };
    for (const [name, answer] of Object.entries(cases)) {
      const net = network({ "i.ytimg.com": answer });
      expect(await fetchVideoCover(youtube, net.fetcher), name).toBeNull();
    }
  });
});
