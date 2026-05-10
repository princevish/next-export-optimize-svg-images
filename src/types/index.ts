export type VariantKey = `${number}` | "original";

export interface ManifestVariant {
  path: string;
  size: number;
}

export interface ManifestEntry {
  type: "svg" | "raster";
  hash: string;
  breakpoints?: readonly number[];
  svg?: ManifestVariant;
  png: Partial<Record<VariantKey, ManifestVariant>>;
  webp: Partial<Record<VariantKey, ManifestVariant>>;
  avif: Partial<Record<VariantKey, ManifestVariant>>;
}

export type ImageManifest = Record<string, ManifestEntry>;

export interface ReferenceSet {
  cms: Set<string>;
  source: Set<string>;
}

export interface ImageTarget {
  manifestKey: string;
  sourcePath: string;
  outputBasename: string;
  kind: "cms" | "source";
}

export type VariantMap = Partial<Record<VariantKey, ManifestVariant>>;

export interface Config {
  projectRoot: string;
  paths: {
    optimized: string;
    manifest: string;
    cacheRoot: string;
  };
  inputImageFolder: string;
  outputImageFolderName: string;
  breakpoints: readonly number[];
  maxNonScaleBreakpoint: number;
  concurrency: number;
  features: {
    svgHighRes: boolean;
    avif: boolean;
    png: boolean;
  };
  webp: {
    quality: number;
    effort: number;
    lossless: boolean;
  };
  avif: {
    quality: number;
    effort: number;
    chromaSubsampling: string;
  };
  png: {
    compressionLevel: number;
    effort: number;
    palette: boolean;
  };
}
