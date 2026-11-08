/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};
export default nextConfig;
