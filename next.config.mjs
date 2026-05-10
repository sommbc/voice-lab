/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/generate": ["./node_modules/ffmpeg-static/**/*"],
    "/api/voice-references": ["./node_modules/ffmpeg-static/**/*"],
    "/api/voxcpm/generate": ["./node_modules/ffmpeg-static/**/*"],
  },
  turbopack: {
    root: process.cwd()
  }
};

export default nextConfig;
