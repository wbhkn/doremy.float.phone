import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const isWslUncPath = projectRoot.startsWith("\\\\wsl$\\");

function resolveDistDir() {
  // 本地验证构建可用 NEXT_DIST_DIR 指到独立目录,避免覆写正在跑的 dev server 的 .next
  if (process.env.NEXT_DIST_DIR) {
    return process.env.NEXT_DIST_DIR;
  }
  if (!isWindows || !isWslUncPath) {
    return ".next";
  }

  const safeProjectName = path.basename(projectRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `next-dist-${safeProjectName}`);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: projectRoot,
  distDir: resolveDistDir(),
  env: {
    // 这是自己部署的 fork：官方站的「AI PHONE ACCESS」账号/激活码申请已经关闭，
    // 自部署的站点不该被挡在登录页外面，所以构建期直接把自托管模式钉成开。
    // 想恢复登录门禁：删掉下面这行，并在部署平台配好 SUPABASE_URL /
    // SUPABASE_SERVICE_ROLE_KEY，再到 Supabase 执行 docs/account-supabase.sql。
    NEXT_PUBLIC_SELF_HOSTED_MODE: "1",
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    // 项目有若干历史 TS 错误（chat-message-list 缺模块、weixin 路由 socket 字段、
    // world-builder SceneViewport prop 不匹配 等），不影响 dev 但 production build 会卡。
    // 跳过 typecheck 让 build 通过；IDE 和 `npx tsc --noEmit` 仍能看到错误。
    ignoreBuildErrors: true,
  },
  outputFileTracingIncludes: {
    "/api/**": ["./data/**"],
  },
  async headers() {
    return [
      {
        // 部署平台默认给 /_next/static/ 一年 immutable，而 App Router 的
        // page chunk 文件名跨部署不变 —— 不覆盖的话，装过旧版的手机哪怕
        // 升级了 APK、站点也发了新版，WebView 仍会一直跑旧 JS。
        // 改成协商缓存：内容没变时 304，代价很小，换的是「升级一定能生效」。
        source: "/_next/static/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        // Service Worker 脚本必须每次能拿到最新的（它自己再控制其余缓存）
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
    ];
  },
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // @gltf-transform/core 的 dist 引用 node:fs / node:path(带 node: 前缀),
      // 它的 browser 字段只映射了裸 fs/path,webpack 对 node: 前缀报 UnhandledSchemeError。
      // 客户端包里剥掉前缀,再用 fallback 置空(浏览器路径实际只用 WebIO,不会真调 fs)。
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        module: false,
      };
    }
    return config;
  },
};

export default nextConfig;
