"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 浮读（阅读 App）：把 public/reader 里的阅读器整页嵌进小手机的 App 舞台。
 * 阅读器自己管理书架/阅读/设置和左上角「退出」；
 * 这里只在它没启动起来时补一个兜底的返回键，避免用户被关在空白页里。
 */
export default function ReaderFrame({ onClose }: { onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (!data) return;
      if (data.type === "float-reader-ready") setReady(true);
      if (data.type === "float-reader-exit") onClose();
    };
    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => setReady(true), 4000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [onClose]);

  const handleFallback = useCallback(() => onClose(), [onClose]);

  return (
    <div className="absolute inset-0 z-[100] bg-[#f3f3f3]">
      <iframe
        ref={frameRef}
        src="/reader/index.html"
        title="浮读"
        className="h-full w-full border-0"
        allow="autoplay; fullscreen"
        onError={() => setReady(false)}
      />
      {!ready ? (
        <button
          type="button"
          onClick={handleFallback}
          aria-label="回到桌面"
          className="absolute left-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-full text-14"
          style={{ background: "rgba(43,43,43,0.4)", color: "#fff" }}
        >
          ‹
        </button>
      ) : null}
    </div>
  );
}
