"use client";

// 「刷B站」设置：开/关能力 + 可选地绑用户自己的 B 站账号（Cookie）。
// 不绑账号也能用：角色看到的是公开热门；绑了就是「用我的号刷」，推荐流是个性化的。

import { useState } from "react";
import { Loader2, KeyRound, Tv } from "lucide-react";
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

export function BilibiliSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
    const [cookie, setCookie] = useState(() => loadBiliCookie());
    const [saved, setSaved] = useState(() => loadBiliCookie());
    const [checking, setChecking] = useState(false);
    const [status, setStatus] = useState<BiliLoginState | null>(null);
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
                    1. 在电脑浏览器（或手机浏览器的「请求桌面网站」）打开 bilibili.com 并登录；
                </span>
                <span className="menu-desc !mt-0">
                    2. 按 F12 打开开发者工具 → Application（应用）→ Cookies → https://www.bilibili.com；
                </span>
                <span className="menu-desc !mt-0">
                    3. 把 SESSDATA、bili_jct、DedeUserID 三项按 <code>SESSDATA=…; bili_jct=…; DedeUserID=…</code> 拼起来粘到上面；
                </span>
                <span className="menu-desc !mt-0">
                    只填 SESSDATA 也能用。这串东西只存在这台手机上，不会上传到别处；在 B 站点「退出登录」它就立刻失效。
                </span>
            </div>
        </div>
    );
}
