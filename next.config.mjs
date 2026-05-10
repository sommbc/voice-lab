/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: new URL(".", import.meta.url).pathname
  }
};

export default nextConfig;
