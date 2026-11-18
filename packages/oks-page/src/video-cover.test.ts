// How the server fetches the picture of a video (PB-94): only the two companies' fixed picture addresses, one request each,
// and anything unexpected gives no picture instead of an error.
import type { VideoSource } from "@oks-page/core";
import { describe, expect, test } from "vitest";
import { fetchMapCover, fetchVideoCover, tileOf } from "./video-cover";

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

describe("fetchMapCover", () => {
  // The centre of a tile, by the inverse formula of the OpenStreetMap wiki.
  const back = (x: number, y: number, z = 15) => {
    const n = 2 ** z;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
    return { lat, lon: ((x + 0.5) / n) * 360 - 180 };
  };

  test("the tile numbers are the ones OpenStreetMap uses", () => {
    // The point 0,0 is the middle of the map; east and north move the numbers the right way; and a tile's own centre
    // lands in the same tile.
    expect(tileOf(0, 0)).toEqual({ x: 16384, y: 16384 });
    expect(tileOf(0, 90).x).toBe(24576);
    expect(tileOf(60, 0).y).toBeLessThan(16384);
    for (const [x, y] of [
      [16383, 10894],
      [5000, 12000],
      [30000, 9000],
    ] as const) {
      const { lat, lon } = back(x, y);
      expect(tileOf(lat, lon)).toEqual({ x, y });
    }
  });

  test("a place is looked up once, then one picture of its tile is asked for, from OpenStreetMap only", async () => {
    const centre = back(16383, 10894);
    const net = network({
      "nominatim.openstreetmap.org": () =>
        json([{ lat: String(centre.lat), lon: String(centre.lon) }]),
      "tile.openstreetmap.org": () => picture("image/png"),
    });
    const got = await fetchMapCover("Royal Observatory, Greenwich", net.fetcher);
    expect(got?.extension).toBe("png");
    expect(net.asked).toEqual([
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=Royal%20Observatory%2C%20Greenwich",
      "https://tile.openstreetmap.org/15/16383/10894.png",
    ]);
  });

  test("a place that is not found, a strange answer or a failed picture gives no picture", async () => {
    const none = network({ "nominatim.openstreetmap.org": () => json([]) });
    expect(await fetchMapCover("nowhere", none.fetcher)).toBeNull();
    expect(none.asked).toHaveLength(1);
    const odd = network({ "nominatim.openstreetmap.org": () => json([{ lat: "x", lon: "2" }]) });
    expect(await fetchMapCover("odd", odd.fetcher)).toBeNull();
    const pole = network({
      "nominatim.openstreetmap.org": () => json([{ lat: "89.9", lon: "2" }]),
    });
    expect(await fetchMapCover("pole", pole.fetcher)).toBeNull();
    const html = network({
      "nominatim.openstreetmap.org": () => json([{ lat: "1", lon: "2" }]),
      "tile.openstreetmap.org": () => picture("text/html"),
    });
    expect(await fetchMapCover("x", html.fetcher)).toBeNull();
  });
});
