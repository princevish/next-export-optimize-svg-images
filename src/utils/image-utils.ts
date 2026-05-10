import type { ManifestEntry, VariantMap } from "../types";

export function isRemoteSource(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("//");
}

export function cleanPath(value: string): string {
  return value.split("?")[0].split("#")[0] ?? value;
}

export function getStaticImportCandidates(value: string): string[] {
  const clean = cleanPath(value);
  const fileName = clean.split("/").pop();
  if (!fileName) return [];
  
  const parts = fileName.split(".");
  if (parts.length < 3) return [];
  
  const ext = parts.at(-1);
  if (!ext) return [];

  const candidates: string[] = [];
  for (let i = parts.length - 2; i >= 1; i -= 1) {
    const stem = parts.slice(0, i).join(".");
    candidates.push(`${stem}.${ext}`);
  }
  return candidates;
}

export function getVariantWidths(variants: VariantMap): Array<{ width: number; path: string; size: number }> {
  const rows: Array<{ width: number; path: string; size: number }> = [];
  for (const [key, variant] of Object.entries(variants)) {
    if (!variant || key === "original") continue;
    const width = Number(key);
    if (!Number.isFinite(width)) continue;
    rows.push({ width, path: variant.path, size: variant.size });
  }
  rows.sort((a, b) => a.width - b.width);
  return rows;
}

export function getSrcSet(variants: VariantMap): string | undefined {
  const rows = getVariantWidths(variants);
  if (rows.length === 0) return undefined;
  return rows.map((row) => `${row.path} ${row.width}w`).join(", ");
}

export function getFallbackPath(variants: VariantMap): string | undefined {
  if (variants.original?.path) return variants.original.path;
  const rows = getVariantWidths(variants);
  return rows.at(-1)?.path;
}

export function getMinRasterSize(entry: ManifestEntry): number | null {
  const sizes = [
    ...Object.values(entry.webp),
    ...Object.values(entry.avif),
    ...Object.values(entry.png),
  ]
    .filter((variant): variant is { path: string; size: number } => Boolean(variant?.path && variant.size))
    .map((variant) => variant.size);

  if (sizes.length === 0) return null;
  return Math.min(...sizes);
}

export function isAvifBetterThanWebp(entry: ManifestEntry): boolean {
  const avif = entry.avif;
  const webp = entry.webp;

  const avifWidths = getVariantWidths(avif);
  const hasAvifOriginal = Boolean(avif.original?.path);
  if (avifWidths.length === 0 && !hasAvifOriginal) return false;

  const webpWidths = getVariantWidths(webp);
  const hasWebpOriginal = Boolean(webp.original?.path);
  if (webpWidths.length === 0 && !hasWebpOriginal) return true;

  if (hasAvifOriginal && hasWebpOriginal) {
    return (avif.original?.size ?? Infinity) < (webp.original?.size ?? 0);
  }

  const commonWidths = avifWidths
    .map((a) => a.width)
    .filter((w) => webpWidths.some((b) => b.width === w));

  if (commonWidths.length > 0) {
    const maxCommon = Math.max(...commonWidths);
    const avifSize = avif[`${maxCommon}`]?.size ?? Infinity;
    const webpSize = webp[`${maxCommon}`]?.size ?? 0;
    return avifSize < webpSize;
  }

  const maxAvif = avifWidths.at(-1)?.size ?? Infinity;
  const maxWebp = webpWidths.at(-1)?.size ?? 0;
  return maxAvif < maxWebp;
}

export function resolveManifestEntry(
  src: string | { src: string }, 
  manifest: Record<string, ManifestEntry>
): { key: string; entry: ManifestEntry } | null {
  const srcValue = typeof src === "string" ? src : src.src;
  const normalized = cleanPath(srcValue);

  // Try direct lookup first (covers CMS images and exact matches)
  if (manifest[normalized]) {
    return { key: normalized, entry: manifest[normalized] };
  }

  // Try static import candidates
  for (const candidate of getStaticImportCandidates(normalized)) {
    if (manifest[candidate]) {
      return { key: candidate, entry: manifest[candidate] };
    }
  }

  return null;
}
