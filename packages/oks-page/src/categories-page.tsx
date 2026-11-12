import type { Metadata } from "next";
import { TaxonomyPage } from "./taxonomy-page";

export const metadata: Metadata = { title: "Categories", robots: { index: false } };

export default function CategoriesPage() {
  return <TaxonomyPage taxonomyKey="category" />;
}
