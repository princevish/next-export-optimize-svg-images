import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Next Export Optimize SVG Images Example",
  description: "Testing the image optimization package",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__NEXT_EXPORT_OPTIMIZE_SVG_IMAGES_MANIFEST_PATH__ = "/optimized-images/manifest.json";`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
