"use client";

import { useEffect } from "react";

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      // updateViaCache: "none" —— /sw.js 自己也不吃 HTTP 缓存，否则新版本
      // 可能要等一天才被检查到。
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => {
          // 页面加载时主动问一次有没有新 SW（默认要等浏览器自己的节奏）
          void registration.update().catch(() => {});
        })
        .catch((error) => {
          console.warn("[PWA] Service worker registration failed:", error);
        });
    };

    // 新 SW 接管后刷新一次：/_next/static 的 chunk 文件名跨部署不变，不刷新
    // 就会继续跑旧代码（升级了 APK 却看到旧页面）。只在页面本来就被旧 SW
    // 接管时刷新，首次安装不刷；同一会话只自动刷一次，避免循环。
    if (navigator.serviceWorker.controller) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        try {
          if (sessionStorage.getItem("float-sw-reloaded") === "1") return;
          sessionStorage.setItem("float-sw-reloaded", "1");
        } catch {
          // 无痕模式拿不到 sessionStorage：照样刷一次
        }
        window.location.reload();
      });
    }

    if (document.readyState === "complete") {
      register();
      return () => {
        cancelled = true;
      };
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
