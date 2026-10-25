/**
 * 「刷B站」能力：模型侧工具的参数声明、调用与结果压缩。
 *
 * 真正的网络请求由同源接口 /api/bili/[action] 代取（服务端只带一个手机 UA，
 * 见 lib/bilibili-server.ts 里关于风控的注释），因为 api.bilibili.com 没有
 * CORS 头、浏览器里直接 fetch 一定失败；search 还需要 md5 的 wbi 签名。
 *
 * 只读：不登录、不点赞投币、不发评论、不收藏。角色能做的只有「看」。
 */

export const BILIBILI_BROWSE_CAPABILITY_ID = "bilibili_browse";

export const BILIBILI_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: ["popular", "ranking", "search", "video", "comments", "related", "online", "user"],
            description:
                "要做什么：popular=热门推荐流（不知道看什么就从这开始）；ranking=排行榜；search=搜视频；video=看某个视频的详情、简介、数据；comments=看这个视频的评论；related=看相关推荐（顺着一路刷下去）；online=看此刻有多少人一起在看；user=看某个 UP 主最近的投稿",
        },
        bvid: {
            type: "string",
            description: "视频号，形如 BV1xx411c7mD。video / comments / related / online 需要",
        },
        keyword: {
            type: "string",
            description: "搜索关键词，search 需要",
        },
        mid: {
            type: "string",
            description: "UP 主的数字 id（视频详情返回的 up_mid），user 需要",
        },
        rid: {
            type: "integer",
            description: "排行榜分区：0=全站 1=动画 4=游戏 36=科技 119=鬼畜 129=舞蹈 155=时尚 181=影视",
        },
        ps: {
            type: "integer",
            description: "一次看几条，默认 10，最多 20",
        },
        page: {
            type: "integer",
            description: "搜索翻页，从 1 开始",
        },
    },
    required: ["action"],
});

export const BILIBILI_USAGE_GUIDE = [
    "【刷B站】你能自己上哔哩哔哩逛，看真实的视频和评论（只读：不登录、不点赞、不投币、不评论、不收藏）。",
    "典型刷法：先 popular 看热门 → 挑一条 video 看详情/简介 → comments 看观众在说什么 → related 顺着推荐继续 → 想找特定的就 search。",
    "怎么用才像真的在刷：不要一次把所有标题念给{{user}}听；挑你真感兴趣的 1-2 条，看完说说你的感受、吐槽、联想到的事，再自然地说你在 B 站看到什么。",
    "参数要点：bvid 是视频号（BV 开头）；user 要 mid（数字 id）；排行榜可带 rid 选分区；一次 ps 不要超过 20。",
    "【边界】遇到「风控」类报错（code -352 / -412）说明 B 站这次不让看，换一个动作或过一会儿再试，不要连着重试同一条。数据只包含公开信息，看不到需要登录的内容。",
].join("\n");

type BiliItem = {
    bvid?: string;
    title?: string;
    up?: string;
    view?: number;
    like?: number;
    danmaku?: number;
    duration?: string;
    link?: string;
    desc?: string;
};

type BiliResponse = {
    ok: boolean;
    action?: string;
    reason?: string;
    message?: string;
    items?: BiliItem[];
    [key: string]: unknown;
};

function compactNumber(value: unknown): string {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
    return String(n);
}

function videoLine(item: BiliItem, index: number, withDesc = false): string {
    const bits = [
        `${index + 1}. ${item.title || "（无标题）"}`,
        item.up ? `UP：${item.up}` : "",
        item.view ? `播放 ${compactNumber(item.view)}` : "",
        item.like ? `赞 ${compactNumber(item.like)}` : "",
        item.duration ? `时长 ${item.duration}` : "",
        item.bvid ? `bvid ${item.bvid}` : "",
    ].filter(Boolean);
    const head = bits.join(" · ");
    return withDesc && item.desc ? `${head}\n   ${item.desc.slice(0, 60)}` : head;
}

function take<T>(items: T[], count: number): T[] {
    return items.length > count ? items.slice(0, count) : items;
}

/** 调同源代理接口。永远返回对象，网络错误也包成 {ok:false}。 */
export async function biliApiCall(action: string, params: Record<string, string | number> = {}): Promise<BiliResponse> {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") return;
        search.set(key, String(value));
    });
    const query = search.toString();
    const url = `/api/bili/${encodeURIComponent(action)}${query ? `?${query}` : ""}`;
    try {
        const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
        const text = await res.text();
        let json: BiliResponse | null = null;
        try {
            json = JSON.parse(text) as BiliResponse;
        } catch {
            return {
                ok: false,
                reason: "bad_response",
                message: `B 站代理返回了非 JSON（HTTP ${res.status}）`,
            };
        }
        if (!json) return { ok: false, reason: "bad_response", message: "B 站代理没有返回内容" };
        return json;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: "network_error", message: `请求 B 站代理失败：${message}` };
    }
}

/** 把接口结果压成模型能读的紧凑文本（会直接进上下文，别铺原始 JSON）。 */
export function formatBiliResult(action: string, data: BiliResponse): string {
    const items = Array.isArray(data.items) ? data.items : [];
    if (action === "search") {
        const keyword = String(data.keyword || "");
        if (!items.length) return `搜「${keyword}」没有结果。`;
        return `B 站搜「${keyword}」的结果：\n${take(items, 8).map((item, index) => videoLine(item, index)).join("\n")}`;
    }
    if (action === "popular") {
        if (!items.length) return "热门页这次是空的。";
        return `B 站热门（当前这一屏）：\n${take(items, 6).map((item, index) => videoLine(item, index, true)).join("\n")}`;
    }
    if (action === "ranking") {
        if (!items.length) return "排行榜这次是空的。";
        return `B 站排行榜：\n${take(items, 8).map((item, index) => videoLine(item, index)).join("\n")}`;
    }
    if (action === "related") {
        if (!items.length) return "这个视频没有相关推荐。";
        return `顺着这个视频刷到的相关推荐：\n${take(items, 6).map((item, index) => videoLine(item, index)).join("\n")}`;
    }
    if (action === "user") {
        const head = [
            `UP 主页：${data.name || "?"}（mid ${data.mid}）`,
            data.fans ? `粉丝 ${compactNumber(data.fans)}` : "",
            data.level ? `等级 ${data.level}` : "",
        ]
            .filter(Boolean)
            .join(" · ");
        const lines = [
            head,
            data.sign ? `签名：${data.sign}` : "",
            items.length
                ? `最近这些投稿：\n${take(items, 8).map((item, index) => videoLine(item, index)).join("\n")}`
                : String(data.note || "（没翻到 TA 的投稿）"),
        ].filter(Boolean);
        return lines.join("\n");
    }
    if (action === "video") {
        const tags = Array.isArray(data.tags) && data.tags.length ? `标签：${(data.tags as string[]).join(" / ")}` : "";
        const lines = [
            `《${data.title || ""}》`,
            `UP：${data.up || ""}（mid ${data.up_mid || "?"}）`,
            data.pubdate ? `发布：${data.pubdate}` : "",
            `时长 ${data.duration || "?"} · 播放 ${compactNumber(data.view)} · 赞 ${compactNumber(data.like)} · 投币 ${compactNumber(data.coin)} · 收藏 ${compactNumber(data.favorite)} · 评论 ${compactNumber(data.reply)} · 弹幕 ${compactNumber(data.danmaku)}`,
            data.pages && Number(data.pages) > 1 ? `分P：${data.pages}` : "",
            tags,
            data.desc ? `简介：${data.desc}` : "",
            data.link ? `链接：${data.link}` : "",
        ].filter(Boolean);
        return lines.join("\n");
    }
    if (action === "comments") {
        if (!items.length) return "这个视频还没有评论。";
        const lines = take(items, 8).map((item, index) => {
            const row = item as unknown as { user?: string; text?: string; like?: number; at?: string };
            return `${index + 1}. ${row.user || "匿名"}：${row.text || ""}${row.like ? `（赞 ${compactNumber(row.like)}）` : ""}`;
        });
        return `评论区（共 ${compactNumber(data.count)} 条）：\n${lines.join("\n")}`;
    }
    if (action === "online") {
        return `此刻有 ${data.total || "?"} 人一起在看这条视频。`;
    }
    return JSON.stringify(data).slice(0, 1500);
}

/** 聊天里给用户看的那一行提示（不喧宾夺主） */
export function biliUserNotice(action: string, data: BiliResponse, args: Record<string, unknown>): string {
    const title = typeof data.title === "string" ? data.title : "";
    if (action === "video" && title) return `📺 在 B 站看了《${title.slice(0, 24)}》`;
    if (action === "search") return `📺 在 B 站搜了「${String(args.keyword || "").slice(0, 20)}」`;
    if (action === "comments") return "📺 在 B 站翻评论区";
    if (action === "related") return "📺 顺着一路往下刷";
    if (action === "ranking") return "📺 在 B 站看排行榜";
    if (action === "user") return "📺 在 B 站翻 UP 主主页";
    if (action === "online") return "📺 在 B 站看有多少人一起看";
    return "📺 在 B 站逛了逛";
}
