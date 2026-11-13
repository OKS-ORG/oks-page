// The cache tag of an address ("slug:about"). Addresses may hold letters of any script, but a cache tag travels in
// headers and tables that expect plain ASCII, so every character outside printable ASCII is percent-encoded. An
// ordinary address ("blog/hello-world") is unchanged. Used by the cached data and by the refresh, so both name the
// same tag.
export const slugTag = (slug: string): string =>
  `slug:${slug.replace(/[^\x20-\x7e]+/g, (part) => encodeURIComponent(part))}`;
