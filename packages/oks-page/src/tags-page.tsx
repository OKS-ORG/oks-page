import type { Metadata } from "next";
import { TaxonomyPage } from "./taxonomy-page";

export const metadata: Metadata = { title: "Tags", robots: { index: false } };

export default function TagsPage() {
  return <TaxonomyPage taxonomyKey="tag" />;
}
