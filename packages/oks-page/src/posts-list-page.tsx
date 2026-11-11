import type { Metadata } from "next";
import { ContentListPage } from "./content-list-page";

export const metadata: Metadata = { title: "Posts", robots: { index: false } };

export default function PostsListPage() {
  return (
    <ContentListPage kind={{ type: "post", segment: "posts", singular: "post", title: "Posts" }} />
  );
}
