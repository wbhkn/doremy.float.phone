"use client";

/**
 * 真实 B 站分享的公共部分（客户端）。
 *
 * 一条「B 站视频」消息长这样：
 *   mediaType: "bilibili"
 *   mediaUrl:  https://www.bilibili.com/video/BVxxxx
 *   mediaData: { bili: BiliCardData, label: 标题 }
 *
 * 为什么把卡片数据直接存进消息里：聊天记录要能离线重看，也不能每次滚动
 * 都去打 B 站接口（那会被风控）。所以只在「发出去的那一刻」取一次真实数据。
 */

export type BiliCardData = {
    bvid: string;
    title: string;
    up: string;
    pic: string;
    view: number;
    duration: string;
};

const BV_PATTERN = /BV[0-9A-Za-z]{10}/;
const AV_PATTERN = /(?:^|[^0-9])av(\d+)/i;
const SHORT_HOSTS = /(^|\.)(b23\.tv|bili2233\.cn)$/;

export function formatBiliCount(value: number): string {
    const n = Number(value) || 0;
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return String(n);
}

/** 从一段文字里认出 B 站视频：返回原始链接（可能是 b23 短链） */
export function extractBiliLink(text: string): string {
    const raw = String(text || "");
    const urlMatch = raw.match(/https?:\/\/[^\s"'<>）)】]+/i);
    if (!urlMatch) {
        const bv = BV_PATTERN.exec(raw);
        return bv ? `https://www.bilibili.com/video/${bv[0]}` : "";
    }
    let candidate = urlMatch[0];
    // 分享文案里的链接常带中文标点/尾巴，去掉
    candidate = candidate.replace(/[，。！？、；：]+$/, "");
    try {
        const parsed = new URL(candidate);
        if (SHORT_HOSTS.test(parsed.hostname)) return parsed.toString();
        if (/bilibili\.com$/i.test(parsed.hostname) || parsed.hostname.endsWith(".bilibili.com")) {
            if (BV_PATTERN.test(parsed.pathname) || AV_PATTERN.test(parsed.pathname) || /\/video\//.test(parsed.pathname)) {
                return parsed.toString();
            }
        }
    } catch {
        return "";
    }
    return "";
}

/** 把任意 B 站链接换成 bvid（短链要走服务端跟跳转） */
export async function resolveBiliBvid(link: string): Promise<string> {
    const direct = BV_PATTERN.exec(link);
    if (direct) return direct[0];
    try {
        const res = await fetch(`/api/bili/resolve?url=${encodeURIComponent(link)}`);
        const json = (await res.json()) as { ok?: boolean; bvid?: string };
        return json?.ok && json.bvid ? String(json.bvid) : "";
    } catch {
        return "";
    }
}

/** 取一条视频的真实卡片数据；取不到返回 null（调用方退化成普通文字消息） */
export async function fetchBiliCard(bvid: string): Promise<BiliCardData | null> {
    if (!BV_PATTERN.test(bvid)) return null;
    try {
        const res = await fetch(`/api/bili/video?bvid=${encodeURIComponent(bvid)}`);
        const json = (await res.json()) as Record<string, unknown>;
        if (!json?.ok) return null;
        return {
            bvid,
            title: String(json.title || "").trim() || bvid,
            up: String(json.up || "").trim(),
            pic: String(json.pic || "").replace(/^http:/, "https:"),
            view: Number(json.view) || 0,
            duration: String(json.duration || ""),
        };
    } catch {
        return null;
    }
}

/** 一段文字 → 卡片数据（不是 B 站链接就返回 null） */
export async function buildBiliCardFromText(text: string): Promise<BiliCardData | null> {
    const link = extractBiliLink(text);
    if (!link) return null;
    const bvid = await resolveBiliBvid(link);
    if (!bvid) return null;
    return fetchBiliCard(bvid);
}

export function biliCardUrl(card: BiliCardData): string {
    return `https://www.bilibili.com/video/${card.bvid}`;
}

/** 给模型看的纯文字版本 */
export function describeBiliCard(card: BiliCardData): string {
    const parts = [`视频《${card.title}》`];
    if (card.up) parts.push(`UP：${card.up}`);
    if (card.duration) parts.push(`时长 ${card.duration}`);
    if (card.view) parts.push(`${formatBiliCount(card.view)}播放`);
    parts.push(biliCardUrl(card));
    return parts.join(" · ");
}
