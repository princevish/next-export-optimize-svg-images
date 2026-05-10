/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    formats: ['image/webp', 'image/avif'],
  },
  // Custom config for our package
  imagesExport: {
    inputImageFolder: 'public/cms-media',
    outputImageFolderName: 'optimized-images',
    breakpoints: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    maxNonScaleBreakpoint: 1920,
    concurrency: 4,
    features: {
      svgHighRes: true,
      avif: true,
      png: true
    },
    webp: {
      quality: 80,
      effort: 4,
      lossless: false
    },
    avif: {
      quality: 65,
      effort: 2,
      chromaSubsampling: '4:2:0'
    },
    png: {
      compressionLevel: 9,
      effort: 10,
      palette: true
    }
  }
};

module.exports = nextConfig;
