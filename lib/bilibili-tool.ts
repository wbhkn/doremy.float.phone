/**
 * 「刷B站」能力：模型侧工具的参数声明、调用与结果压缩。
 *
 * 真正的网络请求由同源接口 /api/bili/[action] 代取（服务端只带一个手机 UA，
 * 见 lib/bilibili-server.ts 里关于风控的注释），因为 api.bilibili.com 没有
 * CORS 头、浏览器里直接 fetch 一定失败；search 还需要 md5 的 wbi 签名。
 *
 * 只读：不点赞投币、不发评论、不收藏。如果这台手机配了用户自己的 B 站账号
 * （Cookie，见 lib/bilibili-auth.ts），请求会带上它，推荐流就是「用我的号刷」；
 * 没配就是匿名看热门。角色能做的始终只有「看」。
 */

import { biliCookieHeader } from "./bilibili-auth";

export const BILIBILI_BROWSE_CAPABILITY_ID = "bilibili_browse";

export const BILIBILI_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: ["feed", "popular", "ranking", "search", "video", "comments", "related", "online", "user", "share"],
            description:
                "要做什么：feed=推荐流（最像真的在刷，想换一批就把 fresh_idx 加 1）；popular=热门；ranking=排行榜；search=搜视频；video=看某个视频的详情、简介、数据；comments=看这个视频的评论；related=看相关推荐（顺着一路刷下去）；online=看此刻有多少人一起在看；user=看某个 UP 主的主页和最近投稿；share=把某条视频真的分享到聊天里给{{user}}看（会发出一张带真实封面的卡片）",
        },
        bvid: {
            type: "string",
            description: "视频号，形如 BV1xx411c7mD。video / comments / related / online / share 需要（传完整链接或 b23.tv 短链也认）",
        },
        title: {
            type: "string",
            description: "视频标题（可选）：记不住 bvid 时，share 可以只传标题，会按标题去搜一条最像的",
        },
        url: {
            type: "string",
            description: "视频链接（可选，替代 bvid）：https://www.bilibili.com/video/BV... 或 https://b23.tv/xxxx",
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
        fresh_idx: {
            type: "integer",
            description: "推荐流第几批，从 1 开始；想「往下滑一屏」就加 1",
        },
    },
    required: ["action"],
});

export const BILIBILI_USAGE_GUIDE = [
    "【刷B站】你能自己上哔哩哔哩逛，看真实的视频和评论（只读：不点赞、不投币、不发评论；看不看得到登录内容取决于{{user}}有没有给账号）。",
    "典型刷法：feed 看一屏推荐 → 挑一条 video 看详情/简介 → comments 看观众在说什么 → related 顺着推荐继续；想换一屏就 feed 把 fresh_idx 加 1；想找特定的就 search；排行榜用 ranking。",
    "怎么用才像真的在刷：不要一次把所有标题念给{{user}}听；挑你真感兴趣的 1-2 条，看完说说你的感受、吐槽、联想到的事，再自然地说你在 B 站看到什么。",
    "如果这台手机配了{{user}}自己的 B 站账号，feed 就是 TA 账号的推荐流——就像你拿 TA 的手机随手刷。看到和 TA 有关的内容可以提一句，但别把 TA 的收藏/历史当谈资逐条汇报。",
    "参数要点：bvid 是视频号（BV 开头）；拿不到 bvid 时可以直接把视频链接放进 url（b23.tv 短链也行）；user 要 mid（数字 id，video 结果里的 up_mid）；排行榜可带 rid 选分区；一次 ps 不要超过 20。",
    "【分享】真看到有意思的视频、想让{{user}}也看一眼时，用 action=share + bvid（或 url；实在记不住视频号就传 title）——聊天里会直接出现一张带真实封面、标题和可复制链接的卡片。分享前先看一眼它是什么（别把没看过的视频丢过去），一次对话里最多分享一两条。分享必须真的调用这个动作：不要在正文里写「[分享视频]」这类占位文字，那样{{user}}只会看到一行字，没有卡片。",
    "【边界】遇到「风控」类报错说明 B 站这次按频率拦了（隔一两分钟再试，别连着重试）；一次对话里别刷太多轮，看几条就够了。",
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
        const res = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json", ...biliCookieHeader() },
        });
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
    if (action === "feed") {
        if (!items.length) return "推荐流这次是空的。";
        return `B 站推荐流第 ${data.freshIdx || 1} 屏：\n${take(items, 6).map((item, index) => videoLine(item, index, true)).join("\n")}`;
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
        return `评论区（共 ${compactNumber(data.count)} 条，B 站只先给了最热的 ${items.length > 8 ? 8 : items.length} 条）：\n${lines.join("\n")}`;
    }
    if (action === "online") {
        return `此刻有 ${data.total || "?"} 人一起在看这条视频。`;
    }
    return JSON.stringify(data).slice(0, 1500);
}

export type BiliLoginState = {
    isLogin: boolean;
    uname: string;
    mid: number;
    level: number;
    vip: boolean;
    message: string;
};

/** 设置页「测试登录」用：拿当前 Cookie 去问 B 站「我是谁」 */
export async function biliCheckLogin(): Promise<BiliLoginState> {
    const data = await biliApiCall("me");
    if (!data.ok) {
        return {
            isLogin: false,
            uname: "",
            mid: 0,
            level: 0,
            vip: false,
            message: data.message || "没能连上 B 站",
        };
    }
    return {
        isLogin: data.isLogin === true,
        uname: typeof data.uname === "string" ? data.uname : "",
        mid: Number(data.mid) || 0,
        level: Number(data.level) || 0,
        vip: data.vip === true,
        message: typeof data.message === "string" ? data.message : "",
    };
}

/** 聊天里给用户看的那一行提示（不喧宾夺主） */
export function biliUserNotice(action: string, data: BiliResponse, args: Record<string, unknown>): string {
    const title = typeof data.title === "string" ? data.title : "";
    if (action === "video" && title) return `📺 在 B 站看了《${title.slice(0, 24)}》`;
    if (action === "search") return `📺 在 B 站搜了「${String(args.keyword || "").slice(0, 20)}」`;
    if (action === "feed") return "📺 在 B 站刷推荐";
    if (action === "comments") return "📺 在 B 站翻评论区";
    if (action === "related") return "📺 顺着一路往下刷";
    if (action === "ranking") return "📺 在 B 站看排行榜";
    if (action === "user") return "📺 在 B 站翻 UP 主主页";
    if (action === "online") return "📺 在 B 站看有多少人一起看";
    if (action === "share" && title) return `📺 把《${title.slice(0, 24)}》分享给了你`;
    return "📺 在 B 站逛了逛";
}

/**
 * 角色主动分享：把一条真实视频变成聊天里的卡片消息。
 *
 * 只做「取一次真实数据 + 落一条消息」这两件事——不生成台词。
 * 台词由模型在工具返回后自己接着说的话负责（continueConversation），
 * 这样分享动作和角色说话的语气能接上。
 */
export async function shareBilibiliVideoToChat(input: {
    sessionId?: string;
    bvid: string;
}): Promise<{ ok: boolean; title?: string; up?: string; message?: string; reason?: string }> {
    const sessionId = String(input.sessionId || "");
    const bvid = String(input.bvid || "").trim();
    if (!sessionId) return { ok: false, reason: "bad_request", message: "不知道分享到哪个会话" };
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return { ok: false, reason: "bad_request", message: "bvid 格式不对" };

    const data = await biliApiCall("video", { bvid });
    if (!data.ok) {
        return {
            ok: false,
            reason: data.reason || "upstream_error",
            message: data.message || "没能取到这条视频的信息",
        };
    }
    const title = typeof data.title === "string" ? data.title : "";
    const up = typeof data.up === "string" ? data.up : "";
    // 动态引入：避免 chat-storage 与工具层在模块初始化时互相牵住
    const { pushChatMessage } = await import("./chat-storage");
    pushChatMessage({
        sessionId,
        role: "assistant",
        content: "",
        mediaType: "bilibili_video_share",
        mediaData: {
            biliBvid: bvid,
            biliTitle: title,
            biliUp: up,
            biliCover: typeof data.pic === "string" ? data.pic : "",
            biliDuration: typeof data.duration === "string" ? data.duration : "",
            biliView: Number(data.view) || 0,
            label: title || "B 站视频",
        },
    });
    return { ok: true, title, up };
}
