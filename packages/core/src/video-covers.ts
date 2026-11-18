// The stored picture of a video or a map (spec 06, 14.3, PB-94): such a block first shows a picture kept on the site, so the
// page asks YouTube, Vimeo or a map company for nothing until the visitor clicks. The server fetches the picture once, when the block is
// saved, and keeps it in Media. How the picture is fetched is decided by the site's server and handed in with
// `setCoverProvider`; this file only decides which blocks need one and keeps the result in the block. A failure leaves the
// block without a picture, and the page then shows a plain placeholder.
import type { Block } from "@oks-page/content-safety";
import { videoOf, type VideoSource } from "@oks-page/renderer";
export type { VideoSource };
import type { Actor } from "./content.js";

/** Gives the address of a stored picture for a video, or null when it could not be fetched. Never throws on a bad network. */
export type CoverProvider = (
  siteId: string,
  video: VideoSource,
  actor: Actor,
) => Promise<string | null>;

let provider: CoverProvider | null = null;

/** Gives the address of a stored picture of a place on OpenStreetMap, or null. */
export type MapCoverProvider = (
  siteId: string,
  query: string,
  actor: Actor,
) => Promise<string | null>;

let mapProvider: MapCoverProvider | null = null;

/** The way this server fetches map pictures (null: none are fetched). */
export function setMapCoverProvider(next: MapCoverProvider | null): void {
  mapProvider = next;
}

/** The way this server fetches video pictures (null: none are fetched). */
export function setCoverProvider(next: CoverProvider | null): void {
  provider = next;
}

/** At most this many pictures are fetched in one save, so a page of many videos cannot hold a save for long. */
export const MAX_COVERS_PER_SAVE = 5;

/**
 * Puts `cover` (the stored picture) and `coverFor` (which video it is of) on each video block that has no picture for
 * its current address. A block that already has the picture for the same video is left alone: it is fetched once. Blocks
 * are changed in place; pass the checked copy.
 */
export async function addCovers(
  blocks: Block[],
  siteId: string,
  actor: Actor,
): Promise<{ fetched: number }> {
  let fetched = 0;
  const walk = async (list: Block[], depth: number): Promise<void> => {
    if (depth > 12) return;
    for (const block of list) {
      if (block.type === "video") {
        const props = block.props as Record<string, unknown>;
        const video = videoOf(typeof props["src"] === "string" ? props["src"] : "");
        const key = video ? `${video.company}:${video.id}` : "";
        if (video && !(props["cover"] && props["coverFor"] === key)) {
          delete props["cover"];
          delete props["coverFor"];
          if (provider && fetched < MAX_COVERS_PER_SAVE) {
            fetched++;
            const url = await provider(siteId, video, actor).catch(() => null);
            if (url) {
              props["cover"] = url;
              props["coverFor"] = key;
            }
          }
        } else if (!video) {
          delete props["cover"];
          delete props["coverFor"];
        }
      }
      if (block.type === "map") {
        const props = block.props as Record<string, unknown>;
        const query = typeof props["query"] === "string" ? props["query"].trim().slice(0, 200) : "";
        // Only OpenStreetMap has a picture that can be fetched without a key.
        const key = query && props["provider"] !== "google" ? `osm:${query}` : "";
        if (key && !(props["cover"] && props["coverFor"] === key)) {
          delete props["cover"];
          delete props["coverFor"];
          if (mapProvider && fetched < MAX_COVERS_PER_SAVE) {
            fetched++;
            const url = await mapProvider(siteId, query, actor).catch(() => null);
            if (url) {
              props["cover"] = url;
              props["coverFor"] = key;
            }
          }
        } else if (!key) {
          delete props["cover"];
          delete props["coverFor"];
        }
      }
      if (Array.isArray(block.children)) await walk(block.children, depth + 1);
    }
  };
  await walk(blocks, 0);
  return { fetched };
}
