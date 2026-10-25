/**
 * 刷B站用的账号凭证（可选）。
 *
 * 只存在这台手机的本地库里（kv-db），不会上传到任何服务器；调用 /api/bili 时
 * 作为请求头 x-bili-cookie 带上，由服务端原样转发给 B 站——这样「角色的代理」
 * 才能用你自己的账号拿到个性化推荐流。
 *
 * 为什么不是登录账号密码：B 站网页端靠 Cookie（SESSDATA 等）认人，没有公开的
 * 账号密码登录接口；让人填 Cookie 也是同样的效果，而且随时能在 B 站「退出登录」
 * 让它失效。
 */

const BILI_COOKIE_KEY = "ai_phone_bili_cookie_v1";

function readRaw(): string {
    if (typeof window === "undefined") return "";
    try {
        return (localStorage.getItem(BILI_COOKIE_KEY) || "").trim();
    } catch {
        return "";
    }
}

export function loadBiliCookie(): string {
    const raw = readRaw();
    if (!raw) return "";
    // 兜底：旧版本可能把明文 SESSDATA 直接存进来（没有 key=value 结构）
    return raw.includes("=") ? raw : `SESSDATA=${raw}`;
}

export function saveBiliCookie(input: string): string {
    const normalized = normalizeBiliCookieInput(input);
    if (typeof window !== "undefined") {
        try {
            if (normalized) localStorage.setItem(BILI_COOKIE_KEY, normalized);
            else localStorage.removeItem(BILI_COOKIE_KEY);
        } catch {
            // 存不进去就算了，别把输入的账号搞丢
        }
    }
    return normalized;
}

export function clearBiliCookie(): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.removeItem(BILI_COOKIE_KEY);
    } catch {
        // ignore
    }
}

/** 容忍「粘贴一整串 Cookie」「只粘贴 SESSDATA 的值」两种输入 */
export function normalizeBiliCookieInput(input: string): string {
    let text = String(input || "").trim();
    if (!text) return "";
    text = text.replace(/^cookie:\s*/i, "").replace(/\s+/g, " ");
    if (!text.includes("=")) {
        // 只给了 SESSDATA 的值
        return `SESSDATA=${text}`;
    }
    // 只保留我们真正需要的键，顺手去掉换行/多余空格
    const wanted = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4", "sid", "bili_ticket"];
    const parts = text
        .split(";")
        .map(item => item.trim())
        .filter(Boolean)
        .filter(item => {
            const key = item.split("=")[0]?.trim() || "";
            return wanted.includes(key);
        });
    return parts.length ? parts.join("; ") : text;
}

/** 给角色/界面看的脱敏描述，绝不回显完整凭证 */
export function describeBiliCookie(cookie: string): string {
    if (!cookie) return "未配置";
    const sess = /SESSDATA=([^;]+)/.exec(cookie)?.[1] || "";
    const uid = /DedeUserID=([^;]+)/.exec(cookie)?.[1] || "";
    const tail = sess.length > 6 ? sess.slice(-6) : "******";
    return uid ? `已配置（UID ${uid}，SESSDATA …${tail}）` : `已配置（SESSDATA …${tail}）`;
}

/** 发给 /api/bili 的请求头：没配置就什么都不加 */
export function biliCookieHeader(): Record<string, string> {
    const cookie = loadBiliCookie();
    return cookie ? { "x-bili-cookie": cookie } : {};
}
