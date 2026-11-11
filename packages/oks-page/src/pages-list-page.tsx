import type { Metadata } from "next";
import { ContentListPage } from "./content-list-page";

export const metadata: Metadata = { title: "Pages", robots: { index: false } };

export default function PagesListPage() {
  return (
    <ContentListPage kind={{ type: "page", segment: "pages", singular: "page", title: "Pages" }} />
  );
}
