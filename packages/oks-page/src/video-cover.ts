// How this server gets the stored picture of a video (spec 06, 14.3, PB-94). Only two companies, only their fixed picture
// addresses, one request each, a short wait and a size limit; nothing about the site or its owner is sent. The picture is
// then checked and stored like any upload. A failure at any step gives null, and the page shows a plain placeholder.
import {
  uploadMedia,
  type CoverProvider,
  type MapCoverProvider,
  type VideoSource,
} from "@oks-page/core";
import { getRunner } from "./db";
import { kickMediaJobs, mediaContextFor } from "./uploads";

const WAIT_MS = 4000;
const MAX_BYTES = 2_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function get(fetcher: Fetcher, url: string, accept: string): Promise<Response | null> {
  try {
    const response = await fetcher(url, {
      // A redirect could lead anywhere; a picture or an answer is expected right here.
      redirect: "manual",
      signal: AbortSignal.timeout(WAIT_MS),
      headers: { accept, "user-agent": "oks-page-cover-fetch" },
    });
    return response.status === 200 ? response : null;
  } catch {
    return null;
  }
}

async function readPicture(
  response: Response,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) return null;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return null;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_BYTES ? { bytes, type } : null;
  } catch {
    return null;
  }
}

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The bytes of the picture of a video, from the company's fixed address; null when there is none to be had. */
export async function fetchVideoCover(
  video: VideoSource,
  fetcher: Fetcher = fetch,
): Promise<{ bytes: Uint8Array; extension: string } | null> {
  let address: string;
  if (video.company === "YouTube") {
    address = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  } else {
    const info = await get(
      fetcher,
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(video.watch)}`,
      "application/json",
    );
    if (!info) return null;
    let thumbnail: string;
    try {
      thumbnail = String(((await info.json()) as { thumbnail_url?: unknown }).thumbnail_url ?? "");
    } catch {
      return null;
    }
    let url: URL;
    try {
      url = new URL(thumbnail);
    } catch {
      return null;
    }
    // Only the company's own picture host.
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "i.vimeocdn.com" || url.hostname.endsWith(".vimeocdn.com"))
    )
      return null;
    address = url.toString();
  }
  const response = await get(fetcher, address, "image/*");
  if (!response) return null;
  const picture = await readPicture(response);
  return picture ? { bytes: picture.bytes, extension: EXTENSION[picture.type]! } : null;
}

/** Keeps a fetched picture in Media, like any upload; the address of the stored copy, or null. */
async function keep(
  siteId: string,
  actor: { userId: string },
  fileName: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const uploaded = await uploadMedia(
    getRunner(),
    await mediaContextFor(siteId),
    // The picture is stored for the page, whoever saved it: this one right is all that is lent.
    { userId: actor.userId, can: (capability) => capability === "media.upload" },
    siteId,
    { fileName, bytes },
  );
  if (!uploaded.ok) return null;
  kickMediaJobs();
  return uploaded.url;
}

/** Fetches the picture and keeps it in Media; the address of the stored copy, or null. */
export const videoCoverProvider: CoverProvider = async (siteId, video, actor) => {
  // A host that allows no request to outside companies from the server sets OKS_VIDEO_COVERS=off.
  if (process.env["OKS_VIDEO_COVERS"] === "off") return null;
  const picture = await fetchVideoCover(video);
  if (!picture) return null;
  return keep(
    siteId,
    actor,
    `${video.company.toLowerCase()}-${video.id}-cover.${picture.extension}`,
    picture.bytes,
  );
};

/** The map tile (zoom 15) that holds a point, as OpenStreetMap numbers them. */
export function tileOf(lat: number, lon: number, zoom = 15): { x: number; y: number } {
  const n = 2 ** zoom;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/** One map tile of a place, from OpenStreetMap: the place is looked up once, then one picture is asked for. */
export async function fetchMapCover(
  query: string,
  fetcher: Fetcher = fetch,
): Promise<{ bytes: Uint8Array; extension: string } | null> {
  const found = await get(
    fetcher,
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
    "application/json",
  );
  if (!found) return null;
  let lat: number;
  let lon: number;
  try {
    const first = ((await found.json()) as { lat?: unknown; lon?: unknown }[])[0];
    lat = Number(first?.lat);
    lon = Number(first?.lon);
  } catch {
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180)
    return null;
  const { x, y } = tileOf(lat, lon);
  const response = await get(fetcher, `https://tile.openstreetmap.org/15/${x}/${y}.png`, "image/*");
  if (!response) return null;
  const picture = await readPicture(response);
  return picture ? { bytes: picture.bytes, extension: EXTENSION[picture.type]! } : null;
}

/** Fetches the map picture of a place and keeps it in Media; the address of the stored copy, or null. */
export const mapCoverProvider: MapCoverProvider = async (siteId, query, actor) => {
  if (process.env["OKS_VIDEO_COVERS"] === "off") return null;
  const picture = await fetchMapCover(query);
  if (!picture) return null;
  const name = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return keep(siteId, actor, `map-${name || "place"}.${picture.extension}`, picture.bytes);
};
