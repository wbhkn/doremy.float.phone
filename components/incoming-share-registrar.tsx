"use client";

/**
 * 系统「分享」进来的内容（Android 壳调用 window.__floatIncomingShare）。
 *
 * 为什么先落到 localStorage 而不是直接写进输入框：
 * 分享发生时用户可能停在桌面（甚至 App 是刚被拉起来的），聊天室根本没挂载。
 * 所以这里只负责收、存、广播；真正「塞进输入框」由聊天室在挂载/切换会话时做。
 * 取走后立刻删除，避免下次打开聊天室又冒出来一条旧分享。
 */

import { useEffect } from "react";

export const INCOMING_SHARE_KEY = "ai_phone_incoming_share_v1";

export type IncomingShare = {
    text: string;
    at: number;
};

export function readIncomingShare(): IncomingShare | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(INCOMING_SHARE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as IncomingShare;
        if (!parsed || typeof parsed.text !== "string" || !parsed.text.trim()) return null;
        // 超过 10 分钟就别再追着用户塞了，静默丢掉
        if (!parsed.at || Date.now() - parsed.at > 10 * 60 * 1000) {
            window.localStorage.removeItem(INCOMING_SHARE_KEY);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function clearIncomingShare() {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(INCOMING_SHARE_KEY);
    } catch {
        /* 隐私模式下写不了就算了 */
    }
}

export function IncomingShareRegistrar() {
    useEffect(() => {
        const handler = (text: unknown) => {
            const value = typeof text === "string" ? text.trim() : "";
            if (!value) return;
            const payload: IncomingShare = { text: value, at: Date.now() };
            try {
                window.localStorage.setItem(INCOMING_SHARE_KEY, JSON.stringify(payload));
            } catch {
                /* 存不下就只广播，聊天室那边顶多这次拿不到 */
            }
            window.dispatchEvent(new CustomEvent("float-incoming-share", { detail: payload }));
        };
        (window as unknown as { __floatIncomingShare?: (text: string) => void }).__floatIncomingShare = handler;
        return () => {
            const w = window as unknown as { __floatIncomingShare?: (text: string) => void };
            if (w.__floatIncomingShare === handler) delete w.__floatIncomingShare;
        };
    }, []);

    return null;
}
