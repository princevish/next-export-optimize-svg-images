"use client";

import React, { createContext, forwardRef, useContext, useEffect, useState } from "react";
import classNames from "classnames";
import type { ManifestEntry } from "../types";
import { 
  getFallbackPath, 
  getMinRasterSize, 
  getSrcSet, 
  isAvifBetterThanWebp, 
  isRemoteSource, 
  resolveManifestEntry 
} from "../utils/image-utils";

export interface ImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> {
  src: string | { src: string };
  fill?: boolean;
  priority?: boolean;
  preload?: boolean;
  unoptimized?: boolean;
  width?: number | `${number}`;
  height?: number | `${number}`;
  sizes?: string;
  manifest?: Record<string, ManifestEntry>;
}

const ManifestContext = createContext<Record<string, ManifestEntry> | null>(null);

export const ManifestProvider: React.FC<{ manifest: Record<string, ManifestEntry>; children: React.ReactNode }> = ({ manifest, children }) => {
  useEffect(() => {
    if (manifest) {
      setGlobalManifest(manifest);
    }
  }, [manifest]);

  return (
    <ManifestContext.Provider value={manifest}>
      {children}
    </ManifestContext.Provider>
  );
};

let globalManifest: Record<string, ManifestEntry> | null = null;
let isFetching = false;
const listeners = new Set<(m: Record<string, ManifestEntry>) => void>();

export const setGlobalManifest = (manifest: Record<string, ManifestEntry>) => {
  globalManifest = manifest;
  listeners.forEach((l) => l(manifest));
};

const DEFAULT_SIZES = "100vw";

export const ExportImage = forwardRef<HTMLImageElement, ImageProps>(
  (
    {
      src,
      fill,
      priority,
      preload,
      unoptimized,
      className,
      style,
      alt,
      loading: providedLoading,
      width,
      height,
      sizes,
      manifest: providedManifest,
      ...props
    },
    ref,
  ) => {
    const contextManifest = useContext(ManifestContext);
    const [manifest, setManifest] = useState<Record<string, ManifestEntry>>(
      providedManifest || contextManifest || globalManifest || {}
    );

    useEffect(() => {
      if (providedManifest) {
        setManifest(providedManifest);
        return;
      }
      if (contextManifest) {
        setManifest(contextManifest);
        return;
      }

      if (globalManifest) {
        setManifest(globalManifest);
        return;
      }

      const onChange = (m: Record<string, ManifestEntry>) => setManifest(m);
      listeners.add(onChange);

      if (!isFetching && typeof window !== "undefined") {
        isFetching = true;
        // Try to get manifest path from global config or default
        const manifestPath = (window as any).__NEXT_EXPORT_OPTIMIZE_SVG_IMAGES_MANIFEST_PATH__ || "/optimized/manifest.json";
        
        fetch(manifestPath)
          .then((res) => res.json())
          .then((data) => {
            setGlobalManifest(data);
          })
          .catch((err) => {
            console.warn("[next-export-optimize-svg-images] Failed to load manifest:", err);
          })
          .finally(() => {
            isFetching = false;
          });
      }

      return () => {
        listeners.delete(onChange);
      };
    }, [providedManifest, contextManifest]);

    const srcValue = typeof src === "string" ? src : src.src;
    const resolved = resolveManifestEntry(src, manifest);
    const isScale = resolved?.key.match(/_scale(?:\.[^.]+)?$/);
    
    const loading = preload || priority || isScale ? "eager" : (providedLoading ?? "lazy");
    const finalSizes = sizes ?? (isScale ? "100vw" : DEFAULT_SIZES);

    const mergedStyle: React.CSSProperties = fill
      ? {
        width: "100%",
        height: "100%",
        objectFit: style?.objectFit ?? "cover",
        ...style,
      }
      : {
        ...style,
      };

    const isBypass = unoptimized || isRemoteSource(srcValue) || srcValue.startsWith("data:") || srcValue.startsWith("blob:") || srcValue.startsWith("/static/");

    const classNameValue = classNames(className);

    if (!resolved || isBypass) {
      return (
        <img
          ref={ref}
          src={srcValue}
          alt={alt ?? ""}
          loading={loading}
          className={classNameValue}
          style={mergedStyle}
          width={!fill ? width : undefined}
          height={!fill ? height : undefined}
          {...(priority || isScale ? { fetchPriority: "high" } : {})}
          {...props}
        />
      );
    }

    const { entry } = resolved;
    const minRasterSize = getMinRasterSize(entry);
    
    if (entry.svg && entry.svg.path && (minRasterSize === null || entry.svg.size <= minRasterSize)) {
      return (
        <img
          ref={ref}
          src={entry.svg.path}
          alt={alt ?? ""}
          loading={loading}
          className={classNameValue}
          style={mergedStyle}
          width={!fill ? width : undefined}
          height={!fill ? height : undefined}
          {...(priority || isScale ? { fetchPriority: "high" } : {})}
          {...props}
        />
      );
    }

    const webpSrcSet = getSrcSet(entry.webp);
    const avifSrcSet = isAvifBetterThanWebp(entry) ? getSrcSet(entry.avif) : undefined;
    const fallbackPath = getFallbackPath(entry.webp) ?? getFallbackPath(entry.avif) ?? entry.svg?.path ?? srcValue;

    return (
      <picture className={className}>
        {avifSrcSet ? <source srcSet={avifSrcSet} sizes={finalSizes} type="image/avif" /> : null}
        {webpSrcSet ? <source srcSet={webpSrcSet} sizes={finalSizes} type="image/webp" /> : null}
        <img
          ref={ref}
          src={fallbackPath}
          alt={alt ?? ""}
          loading={loading}
          className={classNameValue}
          style={mergedStyle}
          width={!fill ? width : undefined}
          height={!fill ? height : undefined}
          sizes={avifSrcSet || webpSrcSet ? finalSizes : undefined}
          {...(priority || isScale ? { fetchPriority: "high" } : {})}
          {...props}
        />
      </picture>
    );
  },
);

ExportImage.displayName = "ExportImage";

export default ExportImage;
