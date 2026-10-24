import { Suspense } from "react";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // The Suspense boundary is required when pages are not prerendered (Next.js 16 with cache components).
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>{children}</Suspense>
      </body>
    </html>
  );
}
