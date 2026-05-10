#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";
import { optimize as optimizeSvg } from "svgo";
import { Command } from "commander";
import { glob } from "glob";

import type { 
  ImageManifest, 
  ManifestEntry, 
  ReferenceSet, 
  ImageTarget, 
  VariantKey, 
  ManifestVariant,
  Config
} from "../types";

// --- Types & Interfaces ---



// --- Utility Class ---

class FileUtils {
  static posixPath(value: string): string {
    return value.replaceAll("\\", "/");
  }

  static async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  static async readJson<T>(filePath: string, fallback: T): Promise<T> {
    if (!(await this.exists(filePath))) return fallback;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  static async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }

  static createHash(data: Buffer | string): string {
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    return typeof data === "string" ? hash : `sha256:${hash}`;
  }
}

// --- Domain Services ---

class ManifestService {
  private currentManifest: ImageManifest = {};
  private paths: { public: string; cache: string };

  constructor(paths: { public: string; cache: string }) {
    this.paths = paths;
  }

  async load(): Promise<void> {
    const publicM = await FileUtils.readJson<ImageManifest>(this.paths.public, {});
    const cacheM = await FileUtils.readJson<ImageManifest>(this.paths.cache, {});
    this.currentManifest = { ...cacheM, ...publicM };
  }

  async persist(): Promise<void> {
    await FileUtils.writeJson(this.paths.public, this.currentManifest);
    await FileUtils.writeJson(this.paths.cache, this.currentManifest);
  }

  getEntry(key: string): ManifestEntry | undefined {
    return this.currentManifest[key];
  }

  async setEntry(key: string, entry: ManifestEntry): Promise<void> {
    this.currentManifest[key] = entry;
    await this.persist();
  }

  removeEntry(key: string): void {
    delete this.currentManifest[key];
  }

  getKeys(): string[] {
    return Object.keys(this.currentManifest);
  }

  getAll(): ImageManifest {
    return this.currentManifest;
  }
}

class ScannerService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async collectReferences(): Promise<ReferenceSet> {
    const cms = new Set<string>();
    const source = new Set<string>();

    const contentDirs = [path.join(this.config.projectRoot, "content")];
    const sourceDirs = [
      path.join(this.config.projectRoot, "src"),
      path.join(this.config.projectRoot, "app"),
      path.join(this.config.projectRoot, "pages")
    ].filter(d => existsSync(d));
    
    console.log(`📂 Scanning directories: ${sourceDirs.join(", ")}`);

    const contentFiles = (await Promise.all(contentDirs.map(p => existsSync(p) ? glob(p.replaceAll("\\", "/") + "/**/*.{json,md}", { absolute: true }) : Promise.resolve([])))).flat();
    const srcFiles = (await Promise.all(sourceDirs.map(p => glob(p.replaceAll("\\", "/") + "/**/*.{ts,tsx,scss,css,js,jsx}", { absolute: true })))).flat();
    
    const basenameToRelPath = await this.buildImageLookup();

    const inputFolderConfig = this.config.inputImageFolder;
    const cmsRegex = new RegExp(`\\/${inputFolderConfig.replaceAll("/", "\\/")}\\/([^ \\s"',)\`]+)`, "g");
    console.log(`🔍 Using CMS Regex: ${cmsRegex.source}`);
    const sourceRegex = /(?:['"]|url\s*\()(?:\/?(?:@|src)|(?:\.\.\/)+|(?:\.\/)+)?\/?assets\/images\/([^'"\)\s?#]+)/g;
    const potentialFilenameRegex = /[a-zA-Z0-9_.-]+\.(?:svg|png|jpg|jpeg|gif|webp|avif)/gi;

    for (const file of contentFiles) {
      const text = await fs.readFile(file, "utf8");
      this.extractRefs(text, cmsRegex, (v) => cms.add(this.normalizeCmsPath(v)));
    }

    for (const file of srcFiles) {
      const text = await fs.readFile(file, "utf8");
      this.extractRefs(text, cmsRegex, (v) => {
        cms.add(this.normalizeCmsPath(v));
      });
      this.extractRefs(text, sourceRegex, (v) => source.add(this.normalizeSourcePath(v)));
      
      for (const match of text.matchAll(potentialFilenameRegex)) {
        const rel = basenameToRelPath.get(match[0]);
        if (rel) source.add(rel);
      }
    }

    console.log(`🔍 Found ${cms.size} CMS references and ${source.size} source references.`);
    return { cms, source };
  }

  private async buildImageLookup() {
    const map = new Map<string, string>();
    const sourceImagesPath = path.join(this.config.projectRoot, "src", "assets", "images");
    if (!existsSync(sourceImagesPath)) return map;
    const all = await glob(path.join(sourceImagesPath, "**/*.{svg,png,jpg,jpeg,gif,webp,avif}"), { absolute: true });
    for (const abs of all) {
      const rel = FileUtils.posixPath(path.relative(sourceImagesPath, abs));
      const bn = path.basename(rel);
      if (map.has(bn)) {
        console.warn(`Duplicate image: "${bn}" in "${map.get(bn)}" and "${rel}". Using the latter.`);
      }
      map.set(bn, rel);
    }
    return map;
  }

  private extractRefs(text: string, regex: RegExp, cb: (val: string) => void) {
    for (const match of text.matchAll(regex)) if (match[1]) cb(match[1]);
  }

  private normalizeCmsPath(raw: string): string {
    return `/${this.config.inputImageFolder}/${raw.split(/[?#]/)[0].trim().replace(/[>\]}`]+$/g, "")}`;
  }

  private normalizeSourcePath(raw: string): string {
    return raw.split(/[?#]/)[0].trim().replaceAll("\\", "/");
  }
}

class ProcessorService {
  private config: Config;
  private dirCreated = new Set<string>();

  constructor(config: Config) {
    this.config = config;
  }

  getOutputBasename(kind: "cms" | "source", relPath: string): string {
    const ext = path.extname(relPath);
    const name = relPath.slice(0, relPath.length - ext.length).replaceAll(/[\/\\]/g, "_");
    const hash = FileUtils.createHash(`${kind}:${relPath}`).substring(0, 8);
    return `${name}-${hash}`;
  }

  async saveOptimized(filename: string, buffer: Buffer): Promise<{ size: number }> {
    const pub = path.join(this.config.paths.optimized, filename);
    const cache = path.join(this.config.paths.cacheRoot, "assets", filename);
    
    const pubDir = path.dirname(pub);
    const cacheDir = path.dirname(cache);

    if (!this.dirCreated.has(pubDir)) {
      await fs.mkdir(pubDir, { recursive: true });
      this.dirCreated.add(pubDir);
    }
    if (!this.dirCreated.has(cacheDir)) {
      await fs.mkdir(cacheDir, { recursive: true });
      this.dirCreated.add(cacheDir);
    }

    await Promise.all([fs.writeFile(pub, buffer), fs.writeFile(cache, buffer)]);
    return { size: buffer.length };
  }

  getPathsFromEntry(entry: ManifestEntry): string[] {
    const res: string[] = [];
    if (entry.svg) res.push(path.join(this.config.paths.optimized, path.basename(entry.svg.path)));
    [entry.png, entry.webp, entry.avif].forEach(fmt => {
      Object.values(fmt).forEach(v => {
        if (v) res.push(path.join(this.config.paths.optimized, path.basename(v.path)));
      });
    });
    return res;
  }

  async optimizeSvg(target: ImageTarget, manifest: ManifestService): Promise<boolean> {
    if (!target.sourcePath.toLowerCase().endsWith(".svg")) return false;
    const buf = await fs.readFile(target.sourcePath);
    const hash = FileUtils.createHash(buf);
    if (manifest.getEntry(target.manifestKey)?.hash === hash && (await FileUtils.exists(path.join(this.config.paths.optimized, `${target.outputBasename}.svg`)))) {
      return true;
    }
    const res = optimizeSvg(buf.toString("utf8"), { multipass: true, path: target.sourcePath });
    const opt = Buffer.from(res.data);
    await this.saveOptimized(`${target.outputBasename}.svg`, opt.length <= buf.length ? opt : buf);
    return false;
  }

  async generateRasters(target: ImageTarget, manifest: ManifestService): Promise<boolean> {
    const raw = await fs.readFile(target.sourcePath);
    const hash = FileUtils.createHash(raw);
    const isSvg = target.sourcePath.toLowerCase().endsWith(".svg");
    const prev = manifest.getEntry(target.manifestKey);
    const skipExisting = prev?.hash === hash;

    if (skipExisting && prev && Object.keys(prev.webp).length > 0) {
      const breakpointsMatch = prev.breakpoints &&
        prev.breakpoints.length === this.config.breakpoints.length &&
        prev.breakpoints.every((b, i) => b === this.config.breakpoints[i]);

      const isMissingBreakpoints = !breakpointsMatch || this.config.breakpoints.some(width => {
        const wasTriedBefore = prev.breakpoints && prev.breakpoints.includes(width);
        if (isSvg) {
          if (!wasTriedBefore) return true;
          const hasWebp = !!prev.webp[`${width}`];
          const hasAvif = !!prev.avif[`${width}`];
          const hasPng = !!prev.png[`${width}`];
          const hasAny = hasWebp || hasAvif || hasPng;
          if (hasAny) {
            if (this.config.features.avif && !hasAvif) return true;
            if (this.config.features.png && !hasPng) return true;
            if (!hasWebp) return true;
          }
          return false;
        }
        if (this.config.features.png && !prev.png[`${width}`]) return true;
        if (!prev.webp[`${width}`]) return true;
        if (this.config.features.avif && !prev.avif[`${width}`]) return true;
        return false;
      });

      if (!isMissingBreakpoints) {
        let allAssetsPresent = true;
        const paths = this.getPathsFromEntry(prev);
        
        await Promise.all(paths.map(async (pub) => {
          if (await FileUtils.exists(pub)) return;
          const cache = path.join(this.config.paths.cacheRoot, "assets", path.basename(pub));
          if (await FileUtils.exists(cache)) {
            const dir = path.dirname(pub);
            if (!this.dirCreated.has(dir)) {
              await fs.mkdir(dir, { recursive: true });
              this.dirCreated.add(dir);
            }
            await fs.copyFile(cache, pub);
          } else {
            allAssetsPresent = false;
          }
        }));

        if (allAssetsPresent && paths.length > 0) return true;
      }
    }

    let input = raw;
    if (isSvg) {
      const optSvg = path.join(this.config.paths.optimized, `${target.outputBasename}.svg`);
      if (await FileUtils.exists(optSvg)) input = await fs.readFile(optSvg);
    }
    const meta = await sharp(input, { animated: !isSvg }).metadata();
    const animated = !isSvg && path.extname(target.sourcePath).toLowerCase() === ".gif" && (meta.pages ?? 1) > 1;

    const isScaleFile = path.basename(target.sourcePath, path.extname(target.sourcePath)).endsWith("_scale");
    const activeBreakpoints = isScaleFile 
      ? this.config.breakpoints 
      : this.config.breakpoints.filter(w => w <= this.config.maxNonScaleBreakpoint);

    const { png, webp, avif, didWork } = await this.encodeFormats(target, input, meta, animated, input.length, isSvg, activeBreakpoints, isScaleFile, skipExisting, prev);

    const entry: ManifestEntry = {
      type: isSvg ? "svg" : "raster",
      hash,
      breakpoints: activeBreakpoints,
      png,
      webp,
      avif,
    };

    if (isSvg) {
      const svgPath = path.join(this.config.paths.optimized, `${target.outputBasename}.svg`);
      if (await FileUtils.exists(svgPath)) {
        entry.svg = { path: `/${this.config.outputImageFolderName}/${path.basename(svgPath)}`, size: (await fs.stat(svgPath)).size };
      }
    }

    await manifest.setEntry(target.manifestKey, entry);
    return skipExisting && !didWork;
  }

  private async encodeFormats(
    target: ImageTarget,
    buf: Buffer, 
    meta: sharp.Metadata, 
    animated: boolean, 
    maxSize: number, 
    isSvg: boolean, 
    activeBreakpoints: readonly number[],
    isScaleFile: boolean,
    skipExisting = false, 
    prev?: ManifestEntry
  ): Promise<{ png: ManifestEntry["png"]; webp: ManifestEntry["webp"]; avif: ManifestEntry["avif"]; didWork: boolean }> {
    const isSvgHighRes = isSvg && this.config.features.svgHighRes;
    let didWork = false;

    // Only keep previous variants if they point to the current output folder
    const outputPrefix = `/${this.config.outputImageFolderName}/`;
    const filterStale = (variants: ManifestEntry["png"]) => {
      if (!variants) return {};
      const filtered: Record<string, ManifestVariant> = {};
      for (const [k, v] of Object.entries(variants)) {
        if (v && v.path.startsWith(outputPrefix)) {
          filtered[k] = v;
        }
      }
      return filtered as ManifestEntry["png"];
    };

    const result: { png: ManifestEntry["png"]; webp: ManifestEntry["webp"]; avif: ManifestEntry["avif"] } = {
      png: prev?.png ? filterStale(prev.png) : {},
      webp: prev?.webp ? filterStale(prev.webp) : {},
      avif: prev?.avif ? filterStale(prev.avif) : {},
    };

    const formats = (["webp", "avif", "png"] as const).filter(f => {
      if (f === "avif") return this.config.features.avif;
      if (f === "png") return this.config.features.png;
      return true;
    });

    const tasks: Promise<void>[] = [];
    const pipeline = sharp(buf, { animated });

    for (const fmt of formats) {
      if (isSvg) {
        tasks.push((async () => {
          let svgSizeExceeded = false;
          for (const w of activeBreakpoints) {
            if (svgSizeExceeded && !isSvgHighRes) break;

            const variantFilename = `${target.outputBasename}_${w}.${fmt}`;
            const key = `${w}` as VariantKey;

            if (skipExisting && result[fmt][key] && (await FileUtils.exists(path.join(this.config.paths.optimized, variantFilename)))) continue;

            try {
              const processed = await pipeline.clone().resize({ width: w })[fmt]({ ...this.config[fmt] }).toBuffer();
              if (isSvgHighRes || isScaleFile || processed.length <= maxSize) {
                const { size } = await this.saveOptimized(variantFilename, processed);
                result[fmt][key] = { path: `/${this.config.outputImageFolderName}/${variantFilename}`, size };
                didWork = true;
              } else {
                svgSizeExceeded = true;
              }
            } catch (e) {
              console.error(`  [Fail] ${target.manifestKey} -> ${fmt} ${w}px:`, e);
            }
          }
        })());
      } else {
        for (const w of activeBreakpoints) {
          if (meta.width && meta.width < w && !isScaleFile) continue;
          const variantFilename = `${target.outputBasename}_${w}.${fmt}`;
          const key = `${w}` as VariantKey;

          if (skipExisting && result[fmt][key] && (await FileUtils.exists(path.join(this.config.paths.optimized, variantFilename)))) continue;

          tasks.push((async () => {
            try {
              const processed = await pipeline.clone().resize({ width: w, withoutEnlargement: !isScaleFile })[fmt]({ ...this.config[fmt] }).toBuffer();
              const { size } = await this.saveOptimized(variantFilename, processed);
              result[fmt][key] = { path: `/${this.config.outputImageFolderName}/${variantFilename}`, size };
              didWork = true;
            } catch (e) {
              console.error(`  [Fail] ${target.manifestKey} -> ${fmt} ${w}px:`, e);
            }
          })());
        }

        const origFilename = `${target.outputBasename}.${fmt}`;
        if (!(skipExisting && result[fmt].original && (await FileUtils.exists(path.join(this.config.paths.optimized, origFilename))))) {
          tasks.push((async () => {
            try {
              const orig = await pipeline.clone()[fmt]({ ...this.config[fmt] }).toBuffer();
              if (orig.length <= maxSize) {
                const { size } = await this.saveOptimized(origFilename, orig);
                result[fmt].original = { path: `/${this.config.outputImageFolderName}/${origFilename}`, size };
                didWork = true;
              }
            } catch (e) {
              console.error(`  [Fail] ${target.manifestKey} -> ${fmt} original:`, e);
            }
          })());
        }
      }
    }

    await Promise.all(tasks);
    return { ...result, didWork };
  }
}

class OptimizationEngine {
  private config: Config;
  private manifest: ManifestService;
  private scanner: ScannerService;
  private processor: ProcessorService;

  constructor(config: Config) {
    this.config = config;
    this.manifest = new ManifestService({
      public: this.config.paths.manifest,
      cache: path.join(this.config.paths.cacheRoot, "manifest.json")
    });
    this.scanner = new ScannerService(config);
    this.processor = new ProcessorService(config);
  }

  async run() {
    const totalStart = Date.now();
    try { sharp.simd(true); } catch {}

    const refs = await this.scanner.collectReferences();
    const targets = this.resolveTargets(refs);
    await this.manifest.load();

    console.log(`🔍 Total images: ${targets.length}. Concurrency: ${this.config.concurrency}`);

    const svgTargets = targets.filter(t => t.sourcePath.toLowerCase().endsWith(".svg"));
    if (svgTargets.length > 0) {
      console.log(`\n🚀 Stage 1: SVGs...`);
      await this.pool(svgTargets, async t => {
        await this.processor.optimizeSvg(t, this.manifest);
      });
    }

    console.log(`\n🚀 Stage 2: Rasters...`);
    let done = 0;
    await this.pool(targets, async t => {
      await this.processor.generateRasters(t, this.manifest);
      done++;
      if (done % 50 === 0 || done === targets.length) console.log(`[${done}/${targets.length}] Processed: ${t.manifestKey}`);
    });

    await this.cleanup(targets);
    await this.manifest.persist();

    console.log(`\n✨ Optimization Complete in ${((Date.now() - totalStart) / 1000).toFixed(2)}s.`);
  }

  private resolveTargets(refs: ReferenceSet): ImageTarget[] {
    const list: ImageTarget[] = [];
    const inputFolder = this.config.inputImageFolder.replace(/^public\//, "").replace(/^\//, "");
    const sourceImagesPath = path.join(this.config.projectRoot, "src", "assets", "images");
    const cmsMediaPath = path.join(this.config.projectRoot, "public", inputFolder);

    refs.source.forEach(rel => {
      const abs = path.join(sourceImagesPath, rel);
      if (existsSync(abs)) list.push({
        manifestKey: path.basename(rel),
        sourcePath: abs,
        outputBasename: this.processor.getOutputBasename("source", rel),
        kind: "source"
      });
    });
    refs.cms.forEach(p => {
      const folder = this.config.inputImageFolder;
      const rel = p.replaceAll(new RegExp(`^\\/${folder.replaceAll("/", "\\/")}\\/`, "g"), "");
      const abs = path.join(cmsMediaPath, rel);
      if (existsSync(abs)) {
        list.push({
          manifestKey: p,
          sourcePath: abs,
          outputBasename: this.processor.getOutputBasename("cms", rel),
          kind: "cms"
        });
      }
    });
    return list;
  }

  private async pool<T>(items: T[], fn: (item: T) => Promise<unknown>) {
    const queue = [...items];
    await Promise.all(Array.from({ length: this.config.concurrency }).map(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) await fn(item);
      }
    }));
  }

  private async cleanup(targets: ImageTarget[]) {
    const targetKeys = new Set(targets.map(t => t.manifestKey));
    const keepPaths = new Set<string>();
    const allEntries = this.manifest.getAll();

    for (const key of targetKeys) {
      const entry = allEntries[key];
      if (entry) {
        this.processor.getPathsFromEntry(entry).forEach(p => keepPaths.add(p));
      }
    }

    const optimizedFiles = await glob(path.join(this.config.paths.optimized, "**/*"), { absolute: true });
    for (const absFile of optimizedFiles) {
      const stats = await fs.stat(absFile);
      if (stats.isDirectory()) continue;
      if (!keepPaths.has(absFile)) {
        await fs.rm(absFile, { force: true });
      }
    }
  }
}

// --- CLI ---

const program = new Command();

program
  .name("next-export-optimize-svg-images")
  .description("CLI to optimize images for Next.js static export")
  .option("-r, --root <path>", "Project root directory", process.cwd())
  .action(async (options) => {
    const root = path.resolve(options.root);
    
    const defaultConfig: Config = {
      projectRoot: root,
      inputImageFolder: "cms-media",
      outputImageFolderName: "optimized",
      paths: {
        optimized: path.join(root, "public", "optimized"),
        manifest: path.join(root, "public", "optimized", "manifest.json"),
        cacheRoot: path.join(root, ".next", "cache", "images"),
      },
      breakpoints: [128, 256, 512, 768, 1024, 1440, 1920, 2560, 3840],
      maxNonScaleBreakpoint: 1920,
      concurrency: Math.min(12, Math.max(1, os.cpus().length)),
      features: {
        svgHighRes: false,
        avif: true,
        png: false,
      },
      webp: { quality: 85, effort: 4, lossless: false },
      avif: { quality: 65, effort: 2, chromaSubsampling: "4:2:0" },
      png: { compressionLevel: 9, effort: 10, palette: true },
    };

    let userConfig: Partial<Config> = {};
    const configPath = path.join(root, "next-export-optimize-svg-images.config.js");
    
    if (existsSync(configPath)) {
      try {
        const imported = await import(pathToFileURL(configPath).href);
        userConfig = imported.default || imported;
        console.log(`📖 Loaded config from ${configPath}`);
      } catch (e) {
        console.warn(`⚠️ Failed to load config file: ${configPath}. Using defaults.`);
      }
    }

    let nextConfig: any = null;
    const nextConfigExtensions = [".js", ".mjs", ".cjs"];
    for (const ext of nextConfigExtensions) {
      const p = path.join(root, `next.config${ext}`);
      if (existsSync(p)) {
        try {
          const imported = await import(pathToFileURL(p).href);
          const configExport = imported.default || imported;
          if (typeof configExport === "function") {
            nextConfig = await configExport("phase-production-build", { defaultConfig: {} });
          } else {
            nextConfig = configExport;
          }
          break;
        } catch (e) {
          // Skip
        }
      }
    }

    let nextBreakpoints: number[] | null = null;
    let nextAvifEnabled = true;

    if (nextConfig) {
      if (nextConfig.images) {
        const nextImages = nextConfig.images;
        if (nextImages.deviceSizes || nextImages.imageSizes) {
          const combined = [
            ...(nextImages.deviceSizes || []),
            ...(nextImages.imageSizes || [])
          ].sort((a, b) => a - b);
          if (combined.length > 0) {
            nextBreakpoints = Array.from(new Set(combined));
          }
        }
        if (nextImages.formats) {
          nextAvifEnabled = nextImages.formats.includes("image/avif");
        }
      }
      
      const specializedConfig = nextConfig.imagesExport || nextConfig.nextExportOptimizeSvgImages;
      if (specializedConfig) {
        userConfig = { ...userConfig, ...specializedConfig };
      }
    }

    const config: Config = {
      ...defaultConfig,
      ...userConfig,
      breakpoints: userConfig.breakpoints || nextBreakpoints || defaultConfig.breakpoints,
      paths: {
        ...defaultConfig.paths,
        ...(userConfig.paths || {}),
      },
      features: {
        ...defaultConfig.features,
        avif: userConfig.features?.avif ?? (nextConfig ? nextAvifEnabled : defaultConfig.features.avif),
        ...(userConfig.features || {}),
      },
      webp: {
        ...defaultConfig.webp,
        ...(userConfig.webp || {}),
      },
      avif: {
        ...defaultConfig.avif,
        ...(userConfig.avif || {}),
      },
      png: {
        ...defaultConfig.png,
        ...(userConfig.png || {}),
      },
    };

    // Re-calculate paths if output folder changed but paths were not explicitly overridden
    if (!userConfig.paths?.optimized && (userConfig.outputImageFolderName || config.outputImageFolderName !== "optimized")) {
      config.paths.optimized = path.join(root, "public", config.outputImageFolderName);
    }
    if (!userConfig.paths?.manifest && (userConfig.outputImageFolderName || config.outputImageFolderName !== "optimized")) {
      config.paths.manifest = path.join(config.paths.optimized, "manifest.json");
    }

    // Normalize inputImageFolder to be the web-accessible path (no public/ prefix)
    config.inputImageFolder = config.inputImageFolder.replace(/^public\//, "").replace(/^\//, "");

    await new OptimizationEngine(config).run();
  });

program.parse();
