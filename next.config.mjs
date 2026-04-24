import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/generate": ["./node_modules/ffmpeg-static/**/*"],
  },
  turbopack: {
    root: __dirname
  }
};

export default nextConfig;
