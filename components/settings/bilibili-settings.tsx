"use client";

// 「刷B站」设置：开/关能力 + 可选地绑用户自己的 B 站账号（Cookie）。
// 不绑账号也能用：角色看到的是公开热门；绑了就是「用我的号刷」，推荐流是个性化的。

import { useState } from "react";
import { Loader2, KeyRound, Tv, Clapperboard } from "lucide-react";
import { Input, Toggle } from "@/components/ui/form";
import {
    clearBiliCookie,
    describeBiliCookie,
    loadBiliCookie,
    saveBiliCookie,
} from "@/lib/bilibili-auth";
import {
    biliCheckLogin,
    BILIBILI_BROWSE_CAPABILITY_ID,
    type BiliLoginState,
} from "@/lib/bilibili-tool";
import {
    getInternalCapability,
    loadInternalCapabilities,
    saveInternalCapabilities,
} from "@/lib/internal-capability-storage";
import {
    DEFAULT_VIDEO_BRIDGE_URL,
    loadVideoBridgeUrl,
    saveVideoBridgeUrl,
} from "@/lib/video-watch-tool";

export function BilibiliSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
    const [cookie, setCookie] = useState(() => loadBiliCookie());
    const [saved, setSaved] = useState(() => loadBiliCookie());
    const [checking, setChecking] = useState(false);
    const [status, setStatus] = useState<BiliLoginState | null>(null);
    // 「看视频」桥：跑在{{user}}自己电脑上（D:\video-bridge），手机上只需要知道地址。
    const [videoBridge, setVideoBridge] = useState(() => loadVideoBridgeUrl());
    const [videoTesting, setVideoTesting] = useState(false);
    const [videoStatus, setVideoStatus] = useState<string>("");

    const handleSaveVideoBridge = async () => {
        const url = saveVideoBridgeUrl(videoBridge) || videoBridge.trim();
        setVideoBridge(url);
        if (!url) {
            setVideoStatus("已清空：角色将无法看视频");
            return;
        }
        setVideoTesting(true);
        setVideoStatus("正在问电脑…");
        try {
            const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(8000) });
            const data = (await res.json()) as { ok?: boolean; ffmpeg?: boolean; clip?: string };
            if (data?.ok) {
                setVideoStatus(
                    data.ffmpeg === false
                        ? "电脑在线，但缺 ffmpeg（桥里跑不起来）"
                        : `✓ 电脑在线${data.clip ? ` · ${data.clip}` : ""}`,
                );
            } else {
                setVideoStatus("✗ 电脑返回了看不懂的东西");
            }
        } catch {
            setVideoStatus(`✗ 连不上（电脑要开着、和手机同一个 WiFi；默认 ${DEFAULT_VIDEO_BRIDGE_URL}）`);
        } finally {
            setVideoTesting(false);
        }
    };
    const [browseOn, setBrowseOn] = useState(() => {
        const capability = getInternalCapability(BILIBILI_BROWSE_CAPABILITY_ID);
        return Boolean(capability && capability.enabled && capability.mode !== "off");
    });

    const handleBrowseToggle = (value: boolean) => {
        const items = loadInternalCapabilities().map(item =>
            item.id === BILIBILI_BROWSE_CAPABILITY_ID
                ? { ...item, enabled: value, mode: (value ? "auto" : "off") as typeof item.mode, updatedAt: Date.now() }
                : item);
        saveInternalCapabilities(items);
        setBrowseOn(value);
        onNotice?.(value ? "已开启：角色可以自己刷 B 站了" : "已关闭：角色不能再刷 B 站");
    };

    const handleSaveAndCheck = async () => {
        const normalized = saveBiliCookie(cookie);
        setSaved(normalized);
        setCookie(normalized);
        if (!normalized) {
            setStatus(null);
            onNotice?.("已清空 B 站账号，角色回到匿名刷");
            return;
        }
        setChecking(true);
        setStatus(null);
        try {
            const result = await biliCheckLogin();
            setStatus(result);
            if (result.isLogin) {
                onNotice?.(`已登录 B 站：${result.uname || "（没拿到昵称）"}`);
            } else {
                onNotice?.(result.message || "这串 Cookie 没生效，可能已经过期");
            }
        } finally {
            setChecking(false);
        }
    };

    const handleClear = () => {
        clearBiliCookie();
        setCookie("");
        setSaved("");
        setStatus(null);
        onNotice?.("已清空 B 站账号");
    };

    return (
        <div className="flex flex-col gap-[16px]">
            <div className="ui-group-card !items-stretch">
                <div className="flex items-start gap-3">
                    <div className="ui-icon-circle shrink-0"><Tv size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label font-medium">刷 B 站</span>
                        <span className="menu-desc !mt-0">
                            角色能自己上哔哩哔哩逛：推荐流、热门、排行榜、搜视频、看简介、翻评论区、顺着相关一路刷。
                            只读——不点赞、不投币、不发评论。
                        </span>
                    </div>
                </div>
                <div className="flex items-center gap-3 mt-4">
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label">允许角色刷 B 站</span>
                        <span className="menu-desc !mt-0">关掉之后这项能力对角色完全不存在</span>
                    </div>
                    <Toggle checked={browseOn} onChange={handleBrowseToggle} />
                </div>
            </div>

            <div className="ui-group-card !items-stretch">
                <div className="flex items-start gap-3">
                    <div className="ui-icon-circle shrink-0"><KeyRound size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label font-medium">用我的账号刷（可选）</span>
                        <span className="menu-desc !mt-0">
                            填你自己的 B 站 Cookie，推荐流就会是个性化的——就像角色拿你的手机随手刷。
                            不填也能用，只是看到的是公开热门。
                        </span>
                    </div>
                </div>

                <div className="flex flex-col gap-3 mt-4">
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label font-medium">B 站 Cookie</span>
                        <Input
                            type="password"
                            value={cookie}
                            placeholder="SESSDATA=xxxx; bili_jct=xxxx; DedeUserID=xxxx"
                            onChange={e => setCookie(e.target.value)}
                        />
                        <span className="menu-desc !mt-0">
                            当前：{describeBiliCookie(saved)}
                        </span>
                    </div>
                    <button
                        type="button"
                        className="ui-btn ui-btn-primary w-full justify-center"
                        disabled={checking}
                        onClick={() => void handleSaveAndCheck()}
                    >
                        {checking ? <><Loader2 size={16} className="animate-spin" /> 正在问 B 站…</> : "保存并测试登录"}
                    </button>
                    {status && (
                        <span className="menu-desc !mt-0 text-center">
                            {status.isLogin
                                ? `✓ 已登录：${status.uname || "（没拿到昵称）"}${status.mid ? `（UID ${status.mid}）` : ""}${status.vip ? " · 大会员" : ""}`
                                : `✗ ${status.message || "不是登录状态"}`}
                        </span>
                    )}
                    {saved && (
                        <button type="button" className="ui-btn w-full justify-center text-[var(--c-danger)]" onClick={handleClear}>
                            清空账号（回到匿名刷）
                        </button>
                    )}
                </div>
            </div>

            <div className="ui-group-card !items-stretch">
                <span className="menu-label font-medium">怎么拿到这串 Cookie</span>
                <span className="menu-desc !mt-0">
                    1. 最省事是用电脑：浏览器打开 bilibili.com 并登录。手边没有电脑的话，手机上装一个 Kiwi Browser（Android 版 Chromium，自带开发者工具），用它登录 bilibili.com；
                </span>
                <span className="menu-desc !mt-0">
                    2. 打开开发者工具（电脑按 F12，Kiwi 在菜单里）→ Application（应用）→ Cookies → https://www.bilibili.com；
                </span>
                <span className="menu-desc !mt-0">
                    3. 找到 SESSDATA（必填）、bili_jct、DedeUserID，按 SESSDATA=…; bili_jct=…; DedeUserID=… 的格式拼成一行，粘到上面。
                </span>
                <span className="menu-desc !mt-0">
                    只填 SESSDATA 也能用。这串东西只存在这台手机上，不会上传到别处；在 B 站「退出登录」它就立刻失效。
                </span>
            </div>

            <div className="ui-group-card !items-stretch">
                <div className="flex items-start gap-3">
                    <div className="ui-icon-circle shrink-0"><Clapperboard size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label font-medium">看视频服务（可选）</span>
                        <span className="menu-desc !mt-0">
                            让角色能真的看见画面：把视频压成一张分镜图再发进聊天。
                            这一步要下载和抽帧，跑在你自己的电脑上（D:\video-bridge），手机只连地址。
                        </span>
                    </div>
                </div>
                <div className="flex flex-col gap-3 mt-4">
                    <Input
                        value={videoBridge}
                        placeholder="http://192.168.10.4:9881"
                        onChange={(e) => setVideoBridge(e.target.value)}
                    />
                    <span className="menu-desc !mt-0">
                        电脑上运行 `python D:\video-bridge\server.py`，手机和电脑连同一个 WiFi；换电脑或 IP 变了就在这里改。
                    </span>
                    <button
                        type="button"
                        className="ui-btn ui-btn-primary w-full justify-center"
                        disabled={videoTesting}
                        onClick={() => void handleSaveVideoBridge()}
                    >
                        {videoTesting ? <><Loader2 size={16} className="animate-spin" /> 正在问电脑…</> : "保存并测试连接"}
                    </button>
                    {videoStatus && <span className="menu-desc !mt-0 text-center">{videoStatus}</span>}
                </div>
            </div>
        </div>
    );
}
