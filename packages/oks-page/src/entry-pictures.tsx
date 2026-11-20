// The pictures in the picture fields of a custom type's entry, drawn above the page's text. Used by the server build
// and the export build, so both write the same page.
import type { PictureView } from "./data/types";

export function EntryPictures({ pictures }: { pictures: PictureView[] }) {
  if (pictures.length === 0) return null;
  return (
    <>
      {pictures.map((p) => (
        <figure key={p.url} style={{ margin: "0 0 1rem" }}>
          <img
            src={p.url}
            alt={p.alt}
            {...(p.width ? { width: p.width } : {})}
            {...(p.height ? { height: p.height } : {})}
            style={{ maxInlineSize: "100%", blockSize: "auto" }}
          />
        </figure>
      ))}
    </>
  );
}
