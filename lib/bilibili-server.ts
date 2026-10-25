import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * B 站公开数据代理（服务端专用）。
 *
 * 为什么必须走服务端：api.bilibili.com 不返回 Access-Control-Allow-Origin，
 * 网页/WebView 里直接 fetch 会被浏览器拦掉；而且 search 需要 wbi 签名（md5，
 * 浏览器端没有现成的 md5）。所以统一由这个模块代取。
 *
 * **请求头只有 User-Agent，别的什么都别加**（实测教训）：
 * - 带 Origin → WAF 直接 403，返回 HTML 错误页；
 * - 带 Referer / Cookie（buvid3 等半套浏览器指纹）→ 排行榜变 -352、搜索返回空列表；
 * - 只有裸 UA 时，热门/排行/搜索/视频详情/评论/相关/在线人数 全部正常。
 * 唯一例外是 UP 主「最近投稿」接口（space/wbi/arc/search）现在直接 412，
 * 所以改用「名片接口 + 按 UP 名字搜索过滤」绕过去。
 */

const UA =
    "Mozilla/5.0 (Linux; Android 10; ALP-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
    14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
    56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * 请求级上下文：登录态 Cookie（可选）。
 *
 * 用 AsyncLocalStorage 而不是给每个 action 加工参，是因为「加 Cookie」这件
 * 事对所有接口都是同一个动作——签名、清洗、组装都在 requestJson 一处完成，
 * 各个 action 不用知道自己带没带账号。
 *
 * 注意：**只有用户自己在设置里粘贴过 Cookie 才会带**，默认是匿名裸 UA。
 */
const requestContext = new AsyncLocalStorage<{ cookie: string }>();

const TIMEOUT_MS = 12_000;

/**
 * B 站按 IP 做频控：同一接口连发几次就会 412「request was banned」，
 * 冷却 1~2 分钟才恢复。所以这里自己排队，任意两次出站请求至少隔 1.5 秒。
 */
const MIN_GAP_MS = 1_500;
let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
        const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        lastRequestAt = Date.now();
        return task();
    });
    queue = run.catch(() => undefined);
    return run;
}

export type BiliActionResult =
    | ({ ok: true; action: string } & Record<string, unknown>)
    | { ok: false; action: string; reason: string; message: string; status?: number };

let wbiCache: { mixinKey: string; at: number } | null = null;
const WBI_TTL = 10 * 60 * 1000;

type CacheEntry = { at: number; payload: BiliActionResult };
const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL: Record<string, number> = {
    feed: 45_000,
    popular: 120_000,
    ranking: 300_000,
    search: 60_000,
    video: 600_000,
    comments: 120_000,
    related: 180_000,
    online: 60_000,
    user: 300_000,
    me: 15_000,
};

function md5(input: string): string {
    return createHash("md5").update(input).digest("hex");
}

class BiliRiskControlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BiliRiskControlError";
    }
}

async function requestJson(url: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const cookie = requestContext.getStore()?.cookie || "";
    try {
        const res = await fetch(url, {
            // 匿名时只有 UA；有账号时才补 Cookie（整串原样转发，不做任何改写）
            headers: cookie ? { "User-Agent": UA, Cookie: cookie } : { "User-Agent": UA },
            cache: "no-store",
            signal: controller.signal,
        });
        const text = await res.text();
        if (res.status === 412 || res.status === 429) {
            throw new BiliRiskControlError(`B 站按频率拦了这次请求（HTTP ${res.status}）`);
        }
        let json: Record<string, unknown> | null = null;
        try {
            json = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new Error(`B 站返回了 HTTP ${res.status} 的非 JSON 内容（大概被风控拦了）`);
        }
        return { status: res.status, json };
    } finally {
        clearTimeout(timer);
    }
}

/** 所有出站请求都排队，保证 1.5s 间隔 */
async function biliJson(url: string): Promise<{ status: number; json: Record<string, unknown> }> {
    return schedule(() => requestJson(url));
}

function keyFromUrl(url: string): string {
    return (url || "").split("/").pop()?.split(".")[0] || "";
}

async function getMixinKey(): Promise<string> {
    if (wbiCache && Date.now() - wbiCache.at < WBI_TTL) return wbiCache.mixinKey;
    const { json } = await biliJson("https://api.bilibili.com/x/web-interface/nav");
    const data = (json.data || {}) as Record<string, unknown>;
    const wbiImg = (data.wbi_img || {}) as Record<string, string>;
    const raw = keyFromUrl(wbiImg.img_url) + keyFromUrl(wbiImg.sub_url);
    if (raw.length < 64) throw new Error("拿不到 B 站的 wbi 签名密钥");
    const mixinKey = MIXIN_KEY_ENC_TAB.map(n => raw[n]).join("").slice(0, 32);
    wbiCache = { mixinKey, at: Date.now() };
    return mixinKey;
}

/** 生成 wbi 签名后的查询串（按 key 排序 + wts + w_rid） */
export function signWbi(params: Record<string, string | number>, mixinKey: string): string {
    const wts = Math.floor(Date.now() / 1000);
    const merged: Record<string, string | number> = { ...params, wts };
    const query = Object.keys(merged)
        .sort()
        .map(key => {
            const value = String(merged[key]).replace(/[!'()*]/g, "");
            return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        })
        .join("&");
    return `${query}&w_rid=${md5(query + mixinKey)}`;
}

function num(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function trim(value: unknown, max: number): string {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stripHtml(value: unknown): string {
    return String(value ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function formatDuration(seconds: number): string {
    if (!seconds || seconds < 0) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** 把视频卡片压成模型能读的最小集合（原接口一条动辄几 KB） */
function shapeVideo(raw: Record<string, unknown>) {
    const stat = (raw.stat || {}) as Record<string, unknown>;
    const owner = (raw.owner || {}) as Record<string, unknown>;
    const bvid = String(raw.bvid || "");
    return {
        bvid,
        title: trim(raw.title, 90),
        up: trim(owner.name ?? raw.author, 30),
        view: num(stat.view ?? raw.play),
        like: num(stat.like),
        danmaku: num(stat.danmaku ?? raw.video_review),
        duration: formatDuration(num(raw.duration)) || trim(raw.duration, 10),
        link: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
        ...(raw.desc ? { desc: trim(raw.desc, 120) } : {}),
    };
}

function riskControl(action: string, code: number): BiliActionResult {
    return {
        ok: false,
        action,
        reason: "risk_control",
        message: `B 站这次没让看（风控 code ${code}），别连着重试同一条，换个方向或者过一会儿再看`,
    };
}

async function fetchViewRaw(bvid: string): Promise<Record<string, unknown>> {
    const { json } = await biliJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    );
    const code = num(json.code);
    if (code !== 0) throw new Error(`视频详情拿不到（code ${code}）`);
    return (json.data || {}) as Record<string, unknown>;
}

/**
 * 网页兜底：直接抓视频页的 OG 标签。
 *
 * 为什么需要：`/x/web-interface/view` 对机房 IP 很敏感，Vercel 出口经常被判风控
 * （popular/search 却照常），结果就是「分享出去只剩一行裸链接」。
 * 视频页 HTML 里的 og:title / og:image / og:description 一样是真实数据，
 * 而且 www.bilibili.com 这条链路宽松得多，所以拿不到 API 时改走这里。
 */
async function fetchWebCard(bvid: string): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await schedule(() =>
            fetch(`https://www.bilibili.com/video/${encodeURIComponent(bvid)}/`, {
                headers: { "User-Agent": UA },
                cache: "no-store",
                signal: controller.signal,
            }),
        );
        if (!res.ok) return null;
        const html = await res.text();
        const meta = (property: string): string => {
            const re = new RegExp(
                `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)`,
                "i",
            );
            return (html.match(re) || [])[1] || "";
        };
        const title = meta("og:title").replace(/_哔哩哔哩.*$/i, "").trim();
        if (!title) return null;
        const aidMatch = html.match(/"aid":(\d{5,})/) || html.match(/av(\d{5,})/);
        const cidMatch = html.match(/"cid":(\d{5,})/);
        return {
            aid: aidMatch ? num(aidMatch[1]) : 0,
            cid: cidMatch ? num(cidMatch[1]) : 0,
            title,
            pic: meta("og:image").replace(/^http:/, "https:"),
            desc: meta("og:description").trim(),
            owner: {},
            stat: {},
            duration: 0,
            pages: [],
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function actionFeed(query: Record<string, string>): Promise<BiliActionResult> {
    const ps = Math.min(Math.max(num(query.ps) || 6, 1), 20);
    const freshIdx = Math.max(num(query.fresh_idx) || 1, 1);
    const url =
        "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd" +
        `?ps=${ps}&fresh_type=4&fresh_idx=${freshIdx}&fresh_idx_1h=${freshIdx}`;
    const { json } = await biliJson(url);
    const code = num(json.code);
    if (code !== 0) return riskControl("feed", code);
    const data = (json.data || {}) as Record<string, unknown>;
    const list = (data.item || data.items || []) as Record<string, unknown>[];
    return {
        ok: true,
        action: "feed",
        freshIdx,
        items: list.map(item => {
            const owner = (item.owner || {}) as Record<string, unknown>;
            const stat = (item.stat || {}) as Record<string, unknown>;
            const bvid = String(item.bvid || "");
            return {
                bvid,
                title: trim(stripHtml(item.title), 90),
                up: trim(owner.name, 30),
                view: num(stat.view),
                like: num(stat.like),
                danmaku: num(stat.danmaku),
                duration: formatDuration(num(item.duration)),
                link: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
                desc: trim(stripHtml(item.desc), 90),
            };
        }),
    };
}

async function actionPopular(query: Record<string, string>): Promise<BiliActionResult> {
    const ps = Math.min(Math.max(num(query.ps) || 10, 1), 20);
    const pn = Math.max(num(query.pn) || 1, 1);
    const { json } = await biliJson(`https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=${pn}`);
    const code = num(json.code);
    if (code !== 0) return riskControl("popular", code);
    const data = (json.data || {}) as Record<string, unknown>;
    const list = (data.list || []) as Record<string, unknown>[];
    return { ok: true, action: "popular", items: list.map(shapeVideo) };
}

async function actionRanking(query: Record<string, string>): Promise<BiliActionResult> {
    const rid = num(query.rid) || 0;
    const { json } = await biliJson(
        `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`,
    );
    const code = num(json.code);
    if (code !== 0) return riskControl("ranking", code);
    const data = (json.data || {}) as Record<string, unknown>;
    const list = (data.list || []) as Record<string, unknown>[];
    return { ok: true, action: "ranking", rid, items: list.slice(0, 20).map(shapeVideo) };
}

async function searchVideos(keyword: string, page: number): Promise<Record<string, unknown>[]> {
    const mixinKey = await getMixinKey();
    const signed = signWbi({ keyword, search_type: "video", page }, mixinKey);
    const { json } = await biliJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${signed}`);
    const data = (json.data || {}) as Record<string, unknown>;
    const list = (data.result || []) as Record<string, unknown>[];
    return list.filter(item => item && (item.bvid || item.aid));
}

async function actionSearch(query: Record<string, string>): Promise<BiliActionResult> {
    const keyword = trim(query.keyword, 40);
    if (!keyword) return { ok: false, action: "search", reason: "bad_request", message: "缺少 keyword" };
    const page = Math.max(num(query.page) || 1, 1);
    const raw = await searchVideos(keyword, page);
    if (!raw.length) {
        return { ok: false, action: "search", reason: "risk_control", message: "B 站这次没返回搜结果，换个词试试" };
    }
    const items = raw.slice(0, 12).map(item => ({
        bvid: String(item.bvid || ""),
        title: trim(stripHtml(item.title), 90),
        up: trim(item.author, 30),
        view: num(item.play),
        danmaku: num(item.video_review),
        duration: trim(item.duration, 10),
        link: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "",
        desc: trim(stripHtml(item.description), 100),
    }));
    return { ok: true, action: "search", keyword, items };
}

async function actionVideo(query: Record<string, string>): Promise<BiliActionResult> {
    const bvid = trim(query.bvid, 20);
    if (!bvid) return { ok: false, action: "video", reason: "bad_request", message: "缺少 bvid" };
    let data: Record<string, unknown>;
    let partial = false;
    try {
        data = await fetchViewRaw(bvid);
    } catch {
        // API 被风控时退回网页 OG 标签：标题和封面照样是真的，只是没有播放数/时长
        const fallback = await fetchWebCard(bvid);
        if (!fallback) {
            return {
                ok: false,
                action: "video",
                reason: "risk_control",
                message: "B 站这次没让看（接口和网页都被拦了），过一会儿再试",
            };
        }
        data = fallback;
        partial = true;
    }
    const stat = (data.stat || {}) as Record<string, unknown>;
    const owner = (data.owner || {}) as Record<string, unknown>;
    const pages = (data.pages || []) as Record<string, unknown>[];
    let tags: string[] = [];
    try {
        const { json } = await biliJson(
            `https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`,
        );
        const list = (json.data || []) as Record<string, unknown>[];
        tags = list.slice(0, 8).map(tag => String(tag.tag_name || "")).filter(Boolean);
    } catch {
        tags = [];
    }
    return {
        ok: true,
        action: "video",
        bvid,
        aid: num(data.aid),
        cid: num(data.cid),
        title: trim(data.title, 120),
        up: trim(owner.name, 40),
        up_mid: num(owner.mid),
        desc: trim(data.desc, 600),
        // 封面：聊天里要画真实视频卡片，缺了它卡片就只剩一行字
        pic: String(data.pic || "").replace(/^http:/, "https:"),
        duration: formatDuration(num(data.duration)),
        pubdate: data.pubdate
            ? new Date(num(data.pubdate) * 1000).toISOString().slice(0, 16).replace("T", " ")
            : "",
        view: num(stat.view),
        like: num(stat.like),
        coin: num(stat.coin),
        favorite: num(stat.favorite),
        share: num(stat.share),
        reply: num(stat.reply),
        danmaku: num(stat.danmaku),
        tags,
        pages: pages.length,
        link: `https://www.bilibili.com/video/${bvid}`,
        ...(partial ? { partial: true } : {}),
    };
}

async function actionComments(query: Record<string, string>): Promise<BiliActionResult> {
    let aid = num(query.aid);
    const bvid = trim(query.bvid, 20);
    if (!aid && bvid) {
        try {
            const view = await fetchViewRaw(bvid);
            aid = num(view.aid);
        } catch {
            // 详情接口被风控时从网页里挖 aid，评论照样能看
            const card = await fetchWebCard(bvid);
            aid = num(card?.aid);
        }
    }
    if (!aid) return { ok: false, action: "comments", reason: "bad_request", message: "缺少 bvid 或 aid" };
    const { json } = await biliJson(
        // nohot=1 是关键：不带它 B 站会走「热评」模式，直接静默返回空列表。
        `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&nohot=1&ps=20&pn=1`,
    );
    const code = num(json.code);
    if (code !== 0) return riskControl("comments", code);
    const data = (json.data || {}) as Record<string, unknown>;
    const replies = (data.replies || []) as Record<string, unknown>[];
    const page = (data.page || {}) as Record<string, unknown>;
    return {
        ok: true,
        action: "comments",
        count: num(page.count),
        items: replies.slice(0, 10).map(reply => {
            const member = (reply.member || {}) as Record<string, unknown>;
            const content = (reply.content || {}) as Record<string, unknown>;
            return {
                user: trim(member.uname, 24),
                text: trim(content.message, 140),
                like: num(reply.like),
            };
        }),
    };
}

async function actionRelated(query: Record<string, string>): Promise<BiliActionResult> {
    const bvid = trim(query.bvid, 20);
    if (!bvid) return { ok: false, action: "related", reason: "bad_request", message: "缺少 bvid" };
    const { json } = await biliJson(
        `https://api.bilibili.com/x/web-interface/archive/related?bvid=${encodeURIComponent(bvid)}`,
    );
    const code = num(json.code);
    if (code !== 0) return riskControl("related", code);
    const list = (json.data || []) as Record<string, unknown>[];
    return { ok: true, action: "related", items: list.slice(0, 10).map(shapeVideo) };
}

async function actionOnline(query: Record<string, string>): Promise<BiliActionResult> {
    const bvid = trim(query.bvid, 20);
    if (!bvid) return { ok: false, action: "online", reason: "bad_request", message: "缺少 bvid" };
    const view = await fetchViewRaw(bvid);
    const cid = num(view.cid);
    const { json } = await biliJson(
        `https://api.bilibili.com/x/player/online/total?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
    );
    const data = (json.data || {}) as Record<string, unknown>;
    return { ok: true, action: "online", bvid, total: trim(data.total, 20) };
}

/**
 * UP 主主页：space/wbi/arc/search 已经被 B 站收得很紧（裸请求直接 412），
 * 所以改成「名片接口拿资料 + 用 UP 名字搜视频再按作者过滤」。
 */
async function actionUser(query: Record<string, string>): Promise<BiliActionResult> {
    const mid = num(query.mid);
    if (!mid) return { ok: false, action: "user", reason: "bad_request", message: "缺少 mid（UP 主的数字 id）" };
    const { json } = await biliJson(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`);
    const code = num(json.code);
    if (code !== 0) return riskControl("user", code);
    const card = ((json.data || {}) as Record<string, unknown>).card as Record<string, unknown> | undefined;
    const name = trim(card?.name, 40);
    const result: BiliActionResult = {
        ok: true,
        action: "user",
        mid,
        name,
        sign: trim(card?.sign, 120),
        fans: num(card?.fans),
        level: num(card?.level_info && (card.level_info as Record<string, unknown>).current_level),
        items: [] as unknown[],
    } as BiliActionResult;
    if (!name) return result;
    try {
        const found = await searchVideos(name, 1);
        const mine = found.filter(item => String(item.author || "").trim() === name).slice(0, 8);
        (result as Record<string, unknown>).items = mine.map(item => ({
            bvid: String(item.bvid || ""),
            title: trim(stripHtml(item.title), 90),
            view: num(item.play),
            duration: trim(item.duration, 10),
            link: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "",
        }));
        (result as Record<string, unknown>).fromSearch = true;
        const items = (result as Record<string, unknown>).items as unknown[];
        if (!items.length) {
            (result as Record<string, unknown>).note =
                "只拿到名片，没搜到 TA 的投稿（B 站不让直接翻别人主页，想看具体视频就用 search）";
        }
    } catch {
        // 搜索失败就只返回名片，不影响主流程
    }
    return result;
}

const ACTIONS = [
    "feed",
    "popular",
    "ranking",
    "search",
    "video",
    "comments",
    "related",
    "online",
    "user",
    "me",
    "resolve",
] as const;

const BV_PATTERN = /BV[0-9A-Za-z]{10}/;
const AV_PATTERN = /(?:^|[^0-9])av(\d+)/i;

function extractBvid(text: string): string {
    const matched = BV_PATTERN.exec(String(text || ""));
    return matched ? matched[0] : "";
}

/**
 * 把一条分享链接/分享文案解析成 bvid。
 *
 * 为什么需要服务端：B 站 App 的「分享 → 复制链接」给的是 b23.tv 短链，
 * 短链的 BV 号藏在 302 跳转后的地址里，浏览器直接 fetch 会被跨域拦掉。
 * 这里只发 HEAD/GET 跟一次跳转，拿到最终 URL 就够。
 */
async function actionResolve(query: Record<string, string>): Promise<BiliActionResult> {
    const rawUrl = String(query.url || "").trim();
    if (!rawUrl) {
        return { ok: false, action: "resolve", reason: "bad_request", message: "缺少链接" };
    }
    const direct = extractBvid(rawUrl);
    if (direct) {
        return { ok: true, action: "resolve", bvid: direct, url: `https://www.bilibili.com/video/${direct}` };
    }
    // 只允许 B 站自家的域名，避免被当成任意 URL 抓取器
    let target: URL;
    try {
        target = new URL(rawUrl);
    } catch {
        return { ok: false, action: "resolve", reason: "bad_request", message: "链接格式不对" };
    }
    if (!/(^|\.)(bilibili\.com|b23\.tv|bili2233\.cn)$/.test(target.hostname)) {
        return { ok: false, action: "resolve", reason: "bad_request", message: "不是 B 站链接" };
    }
    try {
        const res = await fetch(target.toString(), {
            method: "GET",
            redirect: "follow",
            headers: { "User-Agent": UA },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const finalUrl = res.url || "";
        const fromRedirect = extractBvid(finalUrl);
        if (fromRedirect) {
            return { ok: true, action: "resolve", bvid: fromRedirect, url: `https://www.bilibili.com/video/${fromRedirect}` };
        }
        const avMatch = AV_PATTERN.exec(finalUrl) || AV_PATTERN.exec(await res.text());
        if (avMatch) {
            const view = await fetchViewRaw(`av${avMatch[1]}`);
            const bvid = trim(view?.bvid, 24);
            if (bvid) {
                return { ok: true, action: "resolve", bvid, url: `https://www.bilibili.com/video/${bvid}` };
            }
        }
        return {
            ok: false,
            action: "resolve",
            reason: "bad_request",
            message: "这个链接里没找到视频号（可能是专栏、番剧或已删除）",
        };
    } catch {
        return { ok: false, action: "resolve", reason: "upstream_unreachable", message: "短链打不开，可能过期了" };
    }
}

/**
 * 登录态自检（设置页「测试登录」用）。
 * 没带 Cookie 时 isLogin=false，不算错误——那是匿名可用的正常状态。
 */
async function actionMe(): Promise<BiliActionResult> {
    const { json } = await biliJson("https://api.bilibili.com/x/web-interface/nav");
    const data = (json.data || {}) as Record<string, unknown>;
    const level = (data.level_info || {}) as Record<string, unknown>;
    const vip = (data.vip || {}) as Record<string, unknown>;
    const isLogin = data.isLogin === true;
    return {
        ok: true,
        action: "me",
        isLogin,
        uname: trim(data.uname, 40),
        mid: num(data.mid),
        level: num(level.current_level),
        vip: num(vip.status) > 0,
        message: isLogin ? "" : "不是登录状态：Cookie 没配置，或者已经过期了",
    };
}

/** 统一入口：把「我们自己定义的动作名」翻译成 B 站接口调用 */
export async function runBiliAction(
    action: string,
    query: Record<string, string> = {},
    cookie = "",
): Promise<BiliActionResult> {
    const cleanCookie = String(cookie || "").trim();
    if (!cleanCookie) return runBiliActionInner(action, query, false);
    // 带上账号时放进请求级上下文，requestJson 负责补 Cookie 头
    return requestContext.run({ cookie: cleanCookie }, () => runBiliActionInner(action, query, true));
}

async function runBiliActionInner(
    action: string,
    query: Record<string, string>,
    authed: boolean,
): Promise<BiliActionResult> {
    const key = String(action || "").trim().toLowerCase();
    if (!ACTIONS.includes(key as (typeof ACTIONS)[number])) {
        return {
            ok: false,
            action: key,
            reason: "unknown_action",
            message: `不认识的 B 站动作：${key}（支持 ${ACTIONS.join(" / ")}）`,
        };
    }

    // 缓存键要区分「带账号」和「匿名」：个性化推荐流和匿名热门不一样
    const cacheKey = `${key}:${authed ? "u" : "a"}:${JSON.stringify(query)}`;
    const cached = responseCache.get(cacheKey);
    const ttl = CACHE_TTL[key] || 0;
    if (cached && Date.now() - cached.at < ttl) return cached.payload;

    let payload: BiliActionResult;
    try {
        switch (key) {
            case "feed":
                payload = await actionFeed(query);
                break;
            case "popular":
                payload = await actionPopular(query);
                break;
            case "ranking":
                payload = await actionRanking(query);
                break;
            case "search":
                payload = await actionSearch(query);
                break;
            case "video":
                payload = await actionVideo(query);
                break;
            case "comments":
                payload = await actionComments(query);
                break;
            case "related":
                payload = await actionRelated(query);
                break;
            case "online":
                payload = await actionOnline(query);
                break;
            case "user":
                payload = await actionUser(query);
                break;
            case "me":
                payload = await actionMe();
                break;
            case "resolve":
                payload = await actionResolve(query);
                break;
            default:
                payload = { ok: false, action: key, reason: "unknown_action", message: "动作不可用" };
        }
    } catch (error) {
        if (error instanceof BiliRiskControlError) {
            payload = {
                ok: false,
                action: key,
                reason: "risk_control",
                message: "B 站按频率拦了这次请求，隔一两分钟再试，别连着重试",
            };
        } else {
            const message = error instanceof Error ? error.message : String(error);
            payload = {
                ok: false,
                action: key,
                reason: "upstream_unreachable",
                message: `没能连上 B 站：${trim(message, 160)}`,
            };
        }
    }

    if (payload.ok) responseCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
}
