"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 浮读（阅读 App）：把 public/reader 里的阅读器整页嵌进小手机的 App 舞台。
 * 阅读器自己管理书架/阅读/设置，这里只负责铺满、以及「回到桌面」按钮。
 */
export default function ReaderFrame({ onClose }: { onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<"shelf" | "read">("shelf");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; view?: string } | null;
      if (!data || data.type !== "float-reader-view") return;
      setView(data.view === "read" ? "read" : "shelf");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="absolute inset-0 z-[100] bg-[#f3f3f3]">
      <iframe
        ref={frameRef}
        src="/reader/index.html"
        title="浮读"
        className="h-full w-full border-0"
        allow="autoplay; fullscreen"
      />
      {view === "shelf" ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="回到桌面"
          className="absolute right-3 z-20 flex h-9 w-9 items-center justify-center rounded-full text-16"
          style={{
            bottom: 74,
            background: "rgba(43, 43, 43, 0.45)",
            color: "#fff",
            backdropFilter: "blur(6px)",
          }}
        >
          ⌂
        </button>
      ) : null}
    </div>
  );
}
