"use client";

import { useEffect, useState } from "react";

const BVID_RE = /BV[0-9A-Za-z]{10}/;

type BiliCardInfo = {
    bvid: string;
    title: string;
    up: string;
    pic: string;
    duration: string;
    view: number;
};

// 同一条视频在聊天里可能被贴很多次，缓存一下，避免反复打接口。
const cardCache = new Map<string, BiliCardInfo | null>();
const inflight = new Map<string, Promise<BiliCardInfo | null>>();

function formatCount(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return String(n);
}

async function loadCard(bvid: string): Promise<BiliCardInfo | null> {
    if (cardCache.has(bvid)) return cardCache.get(bvid) ?? null;
    const running = inflight.get(bvid);
    if (running) return running;
    const task = (async () => {
        try {
            const res = await fetch(`/api/bili/video?bvid=${encodeURIComponent(bvid)}`, { cache: "no-store" });
            if (!res.ok) return null;
            const data = (await res.json()) as Record<string, unknown>;
            if (!data || data.ok !== true) return null;
            const info: BiliCardInfo = {
                bvid,
                title: String(data.title ?? ""),
                up: String(data.up ?? ""),
                pic: String(data.pic ?? ""),
                duration: String(data.duration ?? ""),
                view: Number(data.view) || 0,
            };
            if (!info.title) return null;
            return info;
        } catch {
            return null;
        } finally {
            inflight.delete(bvid);
        }
    })();
    inflight.set(bvid, task);
    const result = await task;
    cardCache.set(bvid, result);
    return result;
}

/**
 * 角色常常不是「调用分享」，而是在正文里打出 BV 号 / B 站链接。
 * 这种情况下正文下面补一张真卡片，免得只有一串编号。
 */
export function InlineBiliCard({ text }: { text: string }) {
    const match = BVID_RE.exec(text || "");
    const bvid = match ? match[0] : "";
    const [card, setCard] = useState<BiliCardInfo | null>(() => (bvid ? cardCache.get(bvid) ?? null : null));
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!bvid) return;
        let cancelled = false;
        setFailed(false);
        void loadCard(bvid).then(info => {
            if (cancelled) return;
            if (info) setCard(info);
            else setFailed(true);
        });
        return () => {
            cancelled = true;
        };
    }, [bvid]);

    if (!bvid || failed || !card) return null;

    const url = `https://www.bilibili.com/video/${card.bvid}`;
    return (
        <a
            className="chat-bili-share-card chat-bili-inline-card"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={event => event.stopPropagation()}
        >
            <div className="chat-bili-share-cover">
                {card.pic ? <img src={card.pic} alt="" referrerPolicy="no-referrer" loading="lazy" /> : null}
                <span className="chat-bili-share-play">▶</span>
                {card.duration ? <span className="chat-bili-share-duration">{card.duration}</span> : null}
            </div>
            <div className="chat-bili-share-info">
                <div className="chat-bili-share-title">{card.title}</div>
                <div className="chat-bili-share-meta">
                    <span className="chat-bili-share-mark">BILIBILI</span>
                    {card.up ? <span className="chat-bili-share-up">{card.up}</span> : null}
                    {card.view ? <span className="chat-bili-share-view">{formatCount(card.view)}播放</span> : null}
                </div>
                <div className="chat-bili-share-linkline">
                    <span className="chat-bili-share-link">{url.replace(/^https?:\/\//, "")}</span>
                </div>
            </div>
        </a>
    );
}
