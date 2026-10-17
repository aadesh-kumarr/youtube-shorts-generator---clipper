import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: [
    '@ffmpeg-installer/ffmpeg',
    '@ffprobe-installer/ffprobe',
    'fluent-ffmpeg',
  ],
  outputFileTracingExcludes: {
    '/*': ['./public/output/**/*', './public/workspace/**/*'],
  },
};

export default nextConfig;
