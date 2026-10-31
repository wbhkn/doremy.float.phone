// lib/llm-http.ts
// LLM 请求的统一 fetch 出口。所有走 buildProviderRequest 的调用点统一经它发请求：
//  - 普通 provider：浏览器直连（现状不变）；
//  - serverProxy 标记（OpenCode 网关）：改发本站 /api/llm-proxy，由服务端转发，
//    绕过 opencode.ai 未开放浏览器 CORS 的问题。

import type { LlmRequestPayload } from "./llm-provider-adapter";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

const REMOTE_URL_RE = /^https?:\/\//i;
const IMAGE_URL_IN_ERROR_RE = /(?:Failed to download image from|invalid image|Unsupported image_url|image[^\s]*could not be (?:downloaded|fetched))[^\n]*/i;
const IMAGE_DOWNLOAD_ERROR_RE = /Failed to download image from ([^\s"')\]]+)/i;

/** 单张远程图最多取 8MB，转成 data URL 后由服务端/模型自己决定怎么处理。 */
const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024;
/** 一张请求里最多内联这么多张远程图，避免首字延迟被拖垮。 */
const MAX_INLINE_IMAGES = 6;
/** 单张下载超时。 */
const INLINE_TIMEOUT_MS = 8000;

const inlineCache = new Map<string, string | null>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/**
 * 把远程图片抓成 data URL。
 *
 * 为什么需要它：历史消息里只要带一个 http(s) 图片，很多 OpenAI 兼容服务端会**自己去下载**；
 * 对方网络到不了图床（国内图床 / 已过期链接 / 需要 referer）时，整个请求直接 400：
 *   Failed to download image from https://s3.bmp.ovh/...
 * 表现就是「这条会话突然发不出去」。抓成 data URL 之后，服务端不需要再联网。
 */
async function fetchImageAsDataUrl(url: string): Promise<string | null> {
    if (inlineCache.has(url)) return inlineCache.get(url) ?? null;
    let result: string | null = null;
    try {
        const res = await fetch(url, { mode: "cors", credentials: "omit", cache: "force-cache" });
        if (res.ok) {
            const blob = await res.blob();
            const type = (blob.type || "").toLowerCase();
            if ((type.startsWith("image/") || !type) && blob.size > 0 && blob.size <= MAX_REMOTE_IMAGE_BYTES) {
                const buffer = new Uint8Array(await blob.arrayBuffer());
                const mime = type.startsWith("image/") ? type : "image/png";
                result = `data:${mime};base64,${bytesToBase64(buffer)}`;
            }
        }
    } catch {
        // 跨域被拦 / 链接失效 / 超时：交给调用方降级（这一轮少送这张图，不让请求整体失败）
        result = null;
    }
    if (inlineCache.size > 48) inlineCache.clear();
    inlineCache.set(url, result);
    return result;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
}

type ImageSlot = {
    /** 图片描述符对象（OpenAI: {url} / Anthropic: {source} / Gemini: {file_data|inline_data}） */
    holder: Record<string, unknown>;
    /** 从 holder 里取出远程 URL（拿不到说明已经是 data URL / base64，跳过） */
    getUrl: () => string;
    /** 就地替换成 base64 形态；能力不足时返回 false */
    applyDataUrl: (dataUrl: string) => boolean;
    /** 无法内联时的降级：把该 part 换成文本占位（返回替换后的 part 或 null 表示整条删掉） */
    degrade: () => unknown;
};

function parseDataUrlParts(dataUrl: string): { mime: string; data: string } | null {
    const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/is.exec(dataUrl);
    if (!match) return null;
    return { mime: match[1] || "image/png", data: match[2] };
}

/** 收集一条 message/contents 里所有引用远程图片的位置（兼容三家格式）。 */
function collectImageSlots(body: Record<string, unknown>): ImageSlot[] {
    const slots: ImageSlot[] = [];

    const visitParts = (parts: unknown) => {
        if (!Array.isArray(parts)) return;
        parts.forEach((part, index) => {
            if (!isRecord(part)) return;
            // OpenAI / 兼容：{ type: "image_url", image_url: { url } }
            if (isRecord(part.image_url) && typeof part.image_url.url === "string") {
                const imageUrl = part.image_url as Record<string, unknown>;
                const url = String(imageUrl.url);
                if (!REMOTE_URL_RE.test(url)) return;
                slots.push({
                    holder: imageUrl,
                    getUrl: () => String(imageUrl.url),
                    applyDataUrl: (dataUrl) => {
                        imageUrl.url = dataUrl;
                        return true;
                    },
                    degrade: () => ({ type: "text", text: "[图片无法加载]" }),
                });
                return;
            }
            // Anthropic：{ type: "image", source: { type: "url", url } }
            if (isRecord(part.source) && typeof part.source.url === "string") {
                const source = part.source as Record<string, unknown>;
                const url = String(source.url);
                if (!REMOTE_URL_RE.test(url)) return;
                slots.push({
                    holder: source,
                    getUrl: () => String(source.url),
                    applyDataUrl: (dataUrl) => {
                        const parsed = parseDataUrlParts(dataUrl);
                        if (!parsed) return false;
                        source.type = "base64";
                        source.media_type = parsed.mime;
                        source.data = parsed.data;
                        delete source.url;
                        return true;
                    },
                    degrade: () => ({ type: "text", text: "[图片无法加载]" }),
                });
                return;
            }
            // Gemini：{ file_data: { file_uri } }
            if (isRecord(part.file_data) && typeof part.file_data.file_uri === "string") {
                const fileData = part.file_data as Record<string, unknown>;
                const url = String(fileData.file_uri);
                if (!REMOTE_URL_RE.test(url)) return;
                slots.push({
                    holder: fileData,
                    getUrl: () => String(fileData.file_uri),
                    applyDataUrl: (dataUrl) => {
                        const parsed = parseDataUrlParts(dataUrl);
                        if (!parsed) return false;
                        delete part.file_data;
                        part.inline_data = { mime_type: parsed.mime, data: parsed.data };
                        return true;
                    },
                    degrade: () => ({ type: "text", text: "[图片无法加载]" }),
                });
            }
            void index;
        });
    };

    const messages = body.messages;
    if (Array.isArray(messages)) {
        messages.forEach((message) => {
            if (isRecord(message)) visitParts(message.content);
        });
    }
    const contents = body.contents;
    if (Array.isArray(contents)) {
        contents.forEach((content) => {
            if (isRecord(content)) visitParts(content.parts);
        });
    }
    return slots;
}

const failedSlots = new WeakSet<ImageSlot>();

function markFailed(slot: ImageSlot): void {
    failedSlots.add(slot);
    slot.holder.__floatImageUnavailable = true;
}

/**
 * 在发请求前把所有远程图片换成 data URL；抓不下来的就地降级成文本占位。
 * 这样服务端不用联网抓图，也就不会因为某张历史图片过期而整条请求 400。
 */
async function inlineRemoteImages(body: unknown): Promise<Record<string, unknown> | null> {
    if (!isRecord(body)) return null;
    const slots = collectImageSlots(body);
    if (slots.length === 0) return body;

    const pending = slots.slice(0, MAX_INLINE_IMAGES);
    await Promise.all(pending.map(async (slot) => {
        const url = slot.getUrl();
        const dataUrl = await withTimeout(fetchImageAsDataUrl(url), INLINE_TIMEOUT_MS);
        if (!dataUrl || !slot.applyDataUrl(dataUrl)) markFailed(slot);
    }));
    // 超出配额的那几张也不冒风险：直接降级
    slots.slice(MAX_INLINE_IMAGES).forEach(markFailed);
    return body;
}

/** 上一次 400 明确说某张图下载失败时，把所有还没内联的远程图都降级后重试一次。 */
function degradeAllRemoteImages(body: unknown): boolean {
    if (!isRecord(body)) return false;
    const slots = collectImageSlots(body);
    if (slots.length === 0) return false;

    const messages = body.messages;
    const contents = body.contents;
    const containers: unknown[] = [];
    if (Array.isArray(messages)) messages.forEach((m) => { if (isRecord(m)) containers.push(m.content); });
    if (Array.isArray(contents)) contents.forEach((c) => { if (isRecord(c)) containers.push(c.parts); });

    // 先按 part 容器逐个替换，避免找不到 part 时改坏结构
    let changed = false;
    containers.forEach((container) => {
        if (!Array.isArray(container)) return;
        for (let i = container.length - 1; i >= 0; i--) {
            const part = container[i];
            if (!isRecord(part)) continue;
            const isRemoteImage = (isRecord(part.image_url) && typeof part.image_url.url === "string" && REMOTE_URL_RE.test(part.image_url.url))
                || (isRecord(part.source) && typeof part.source.url === "string" && REMOTE_URL_RE.test(part.source.url))
                || (isRecord(part.file_data) && typeof part.file_data.file_uri === "string");
            if (isRemoteImage) {
                container[i] = { type: "text", text: "[图片无法加载]" };
                changed = true;
            }
        }
    });
    return changed;
}

/** 上一次 400 明确说 inlineData 不能出现在历史里时，把所有内联图片降级成文本重试一次。 */
function degradeAllInlineData(body: unknown): boolean {
    if (!isRecord(body)) return false;
    const contents = body.contents;
    if (!Array.isArray(contents)) return false;

    let changed = false;
    contents.forEach((content) => {
        if (!isRecord(content) || !Array.isArray(content.parts)) return;
        const parts = content.parts as unknown[];
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (!isRecord(part)) continue;
            if (isRecord(part.inlineData) || isRecord(part.inline_data)) {
                parts[i] = { text: "[图片]" };
                changed = true;
            }
        }
    });
    return changed;
}

/**
 * 另一种请求体：OpenAI / Anthropic 的 messages 数组。
 *
 * 中转收到 image_url 后自己会把它转成 Gemini 的 inlineData，于是同样会 400
 * （contents[N].parts[M].inlineData is not supported in text history）。
 * 这里把「最后一条 user 消息以外」的图片都换成文本占位，再重试一次。
 */
function degradeHistoryImagesInMessages(body: unknown): boolean {
    if (!isRecord(body)) return false;
    const messages = body.messages;
    if (!Array.isArray(messages)) return false;

    let lastUserIndex = -1;
    messages.forEach((message, index) => {
        if (isRecord(message) && message.role === "user") lastUserIndex = index;
    });

    let changed = false;
    messages.forEach((message, index) => {
        if (!isRecord(message) || index >= lastUserIndex) return;
        if (!Array.isArray(message.content)) return;
        const content = message.content as unknown[];
        for (let i = 0; i < content.length; i += 1) {
            const part = content[i];
            if (!isRecord(part)) continue;
            const isImage =
                isRecord(part.image_url) ||
                isRecord(part.source) ||
                part.type === "image" ||
                part.type === "image_url";
            if (isImage) {
                content[i] = { type: "text", text: "[图片]" };
                changed = true;
            }
        }
    });
    return changed;
}

function responseMentionsInlineDataRejection(status: number, errorText: string): boolean {
    if (status !== 400 && status !== 422) return false;
    return /inline_?data/i.test(errorText) && /(not supported|invalid|unsupported|not allowed)/i.test(errorText);
}

function responseMentionsImageDownloadError(status: number, errorText: string): boolean {
    if (status !== 400 && status !== 422) return false;
    return IMAGE_URL_IN_ERROR_RE.test(errorText) || IMAGE_DOWNLOAD_ERROR_RE.test(errorText);
}

function sendOnce(payload: LlmRequestPayload, bodyText: string, signal?: AbortSignal): Promise<Response> {
    if (payload.serverProxy) {
        return fetch("/api/llm-proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: payload.url,
                headers: payload.headers,
                body: bodyText,
            }),
            signal,
        });
    }
    return fetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: bodyText,
        signal,
    });
}

export async function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    // 只处理确实含图片的请求（纯文本请求完全不碰，零开销）
    let body: Record<string, unknown> | null = isRecord(payload.body) ? { ...(payload.body as Record<string, unknown>) } : null;
    if (body && collectImageSlots(body).length > 0) {
        body = await inlineRemoteImages(body);
    }
    const bodyText = JSON.stringify(body ?? payload.body);
    const response = await sendOnce(payload, bodyText, options.signal);
    if (response.ok) return response;

    // 服务端仍说图下不下来（CDN 防盗链 / 链接彻底失效 / 我们这边跨域抓不到）：
    // 去掉这些图片重试一次——「这一轮少送一张图」远好过「整条会话发不出消息」。
    let errorText = "";
    try { errorText = await response.clone().text(); } catch { errorText = ""; }

    // 中转/新版 Gemini 会拒收历史里的 inlineData：把所有内联图降级成 [图片] 再试一次。
    if (responseMentionsInlineDataRejection(response.status, errorText)) {
        const next = body ?? (isRecord(payload.body) ? { ...(payload.body as Record<string, unknown>) } : null);
        // 两种请求体都要兜：Gemini 原生是 contents[].parts[].inlineData；
        // 经中转（OpenAI 兼容）时 body 是 messages[]，要按历史图片降级。
        if (next && (degradeAllInlineData(next) || degradeHistoryImagesInMessages(next))) {
            const retried = await sendOnce(payload, JSON.stringify(next), options.signal);
            if (retried.ok) return retried;
            try { errorText = await retried.clone().text(); } catch { errorText = ""; }
            return retried;
        }
    }

    if (!body || !responseMentionsImageDownloadError(response.status, errorText)) return response;
    if (!degradeAllRemoteImages(body)) return response;

    return sendOnce(payload, JSON.stringify(body), options.signal);
}
