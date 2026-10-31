/**
 * 「看视频」能力：让角色真的看一眼某个视频的画面。
 *
 * 手机端做不了抽帧（没有 ffmpeg、视频在 CDN 上还带防盗链），所以这一步交给
 * {{user}}自己电脑上的「看视频桥」（D:\video-bridge，端口 9881）：
 *   下载 360p 副本 → 每秒抽一张缩略图算变化 → 按信息量切成 N 格 →
 *   每格挑一帧拼成一张宫格图（带格号 + 起止时间）。
 *
 * 拿到图之后两件事同时发生：
 *   1. 图片以「手机发来的分镜」进聊天 —— 模型和{{user}}都能看到；
 *   2. 工具结果里给出每格的起止秒，模型据此说「第 3 格那一下」。
 *
 * 边界：只读。桥只在本机跑，不联网上传；一次一件，生成要 5~15 秒。
 */

export const VIDEO_WATCH_CAPABILITY_ID = "video_watch";

const STORAGE_KEY = "ai_phone_video_bridge_v1";

/** 默认就是上次发现的那台电脑；换机器时在设置里改。 */
export const DEFAULT_VIDEO_BRIDGE_URL = "http://192.168.10.4:9881";

export function loadVideoBridgeUrl(): string {
    if (typeof window === "undefined") return DEFAULT_VIDEO_BRIDGE_URL;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return DEFAULT_VIDEO_BRIDGE_URL;
        return raw.trim();
    } catch {
        return DEFAULT_VIDEO_BRIDGE_URL;
    }
}

export function saveVideoBridgeUrl(url: string): string {
    const next = url.trim();
    if (typeof window === "undefined") return next;
    try {
        window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
        /* 存不进去就下次再存 */
    }
    return next;
}

export const VIDEO_WATCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        url: {
            type: "string",
            description: "视频地址：B 站链接（https://www.bilibili.com/video/BV... 或 https://b23.tv/...）或 BV 号",
        },
        cells: {
            type: "integer",
            description: "分几格看，默认 9；短片段想看得更细可以给 12，长视频别超过 16",
        },
    },
    required: ["url"],
});

export const VIDEO_WATCH_USAGE_GUIDE = [
    "【看视频】你能真的看一眼视频的画面，而不只是看标题简介。",
    "什么时候用：{{user}}发了一个视频链接让你看看、你想评论某条 B 站视频到底拍了什么、或者你想确认一条视频值不值得分享。光是「看看这视频标题讲什么」不用调它，用【刷B站】的 video 就够了——这一步要下载和抽帧，慢一些（5~15 秒），别随手乱调。",
    "怎么用：把链接或 BV 号传进去。出来的结果里有一张分镜图（已经在聊天里了，你能看到画面）和每格的起止时间。",
    "看完要具体：说画面里真的有什么、第几格那个动作/镜头是什么、和你预想的一样不一样。不要说「很有创意」「内容很丰富」这种放之四海皆准的话——你没看画面也能说这种话，那等于没看。",
    "边界：一次一条；同样一条视频别反复调（图会重复占位置）；桥没开或不在同一个 WiFi 时会失败，失败就直说「看不了」，别猜内容。",
].join("\n");

export type VideoCell = { index: number; start: number; end: number };

export type VideoWatchResult =
    | {
        ok: true;
        title: string;
        duration: number;
        cells: VideoCell[];
        imageRef: string;
        elapsed: number;
    }
    | { ok: false; message: string };

function fmt(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m}:${String(rest).padStart(2, "0")}`;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/**
 * 调桥出一张分镜图，并把图落进聊天。
 *
 * 失败一律返回 {ok:false,message}，message 是给模型看的一句话（也顺带进聊天提示）。
 */
export async function watchVideo(input: {
    url: string;
    cells?: number;
}): Promise<VideoWatchResult> {
    const target = String(input.url || "").trim();
    if (!target) return { ok: false, message: "没给视频地址" };
    const base = loadVideoBridgeUrl().replace(/\/+$/, "");
    if (!base) return { ok: false, message: "还没填「看视频服务」的地址（设置 → 刷 B 站）" };

    const cells = Math.max(4, Math.min(16, Number(input.cells) || 9));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);

    let payload: {
        ok?: boolean;
        title?: string;
        image?: string;
        cells?: VideoCell[];
        duration?: number;
        elapsed?: number;
        message?: string;
    };
    try {
        const res = await fetch(
            `${base}/storyboard?cells=${cells}&url=${encodeURIComponent(target)}`,
            { signal: controller.signal, headers: { Accept: "application/json" } },
        );
        payload = (await res.json()) as typeof payload;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            message: controller.signal.aborted
                ? "看视频桥超时了（视频太长或电脑没在跑桥）"
                : `连不上看视频桥（${base}）：${message}。电脑要开着、和手机连同一个 WiFi`,
        };
    } finally {
        clearTimeout(timer);
    }

    if (!payload?.ok || !payload.image) {
        return { ok: false, message: payload?.message || "桥没能出这张分镜图" };
    }

    const title = String(payload.title || "视频").trim();
    const list: VideoCell[] = Array.isArray(payload.cells) ? payload.cells : [];

    // 把图存进相册，交给执行器作为 mediaAttachments 回传：
    // 聊天引擎会在**同一轮**请求里把它当成图片消息塞进去，模型当场就能看见画面，
    // 同时 handleToolExecution 会把它落成一条聊天消息——不用在这里手动 push（否则重复）。
    let imageRef = "";
    try {
        const img = await fetch(payload.image);
        if (!img.ok) throw new Error(`HTTP ${img.status}`);
        const bytes = new Uint8Array(await img.arrayBuffer());
        const { storeMediaBase64 } = await import("./media-cache-storage");
        const stored = await storeMediaBase64(toBase64(bytes), "image/png");
        imageRef = stored.ref;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message: `分镜图拿到了，但没能存进相册：${message}` };
    }

    return {
        ok: true,
        title,
        duration: Number(payload.duration) || 0,
        cells: list,
        imageRef,
        elapsed: Number(payload.elapsed) || 0,
    };
}

/** 工具结果文本：只给原材料（时间 + 格号），不下结论。 */
export function formatVideoWatchResult(result: VideoWatchResult): string {
    if (!result.ok) return `看视频失败：${result.message}`;
    const rows = result.cells.map(
        (cell) => `第 ${cell.index} 格 ${fmt(cell.start)}–${fmt(cell.end)}`,
    );
    return [
        `《${result.title}》（${fmt(result.duration)}，${result.cells.length} 格，生成用了 ${result.elapsed.toFixed(1)} 秒）`,
        "分镜图已经发到聊天里了，你现在能看到画面；这张图从左到右、从上到下就是这几格：",
        rows.join("\n"),
        "要说的时候带上格号（例如「第 3 格他抬手那一下」），也别把每格都念一遍。",
    ].join("\n");
}
