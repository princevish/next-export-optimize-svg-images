import { ExportImage } from "next-export-optimize-svg-images";

export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Image Optimization Test</h1>
      
      <section>
        <h2>Local Image (Public Folder)</h2>
        <div style={{ position: "relative", width: "300px", height: "200px" }}>
          <ExportImage
            src="/cms-media/test-image.png"
            alt="Test Image"
            fill
            style={{ objectFit: "cover" }}
          />
        </div>
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2>SVG Test</h2>
        <ExportImage
          src="/cms-media/logo.svg"
          alt="Logo SVG"
          width={100}
          height={100}
        />
      </section>
    </main>
  );
}
