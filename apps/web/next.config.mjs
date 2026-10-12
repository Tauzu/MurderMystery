/* global process */
const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@mm/shared', '@mm/game-core'],
  // 画面と同じオリジンの /api/* を、APIサーバーへ中継する（Cookieを同一オリジンで扱うため）
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};
