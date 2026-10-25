// 打开外链。
//
// 为什么不能直接 window.open：安卓壳的 WebView 默认不开多窗口
// （setSupportMultipleWindows 没开、也没有 onCreateWindow），
// window.open(url, "_blank") 在壳里会被静默丢掉——用户点了「一键部署」
// 看起来像按钮坏了。壳里必须走原生 ACTION_VIEW，普通浏览器才用新标签页。

type ShellLike = { openUrl?: (url: string) => unknown };

export function openExternalUrl(url: string): void {
    if (typeof window === "undefined" || !url) return;
    const shell = (window as unknown as { AndroidShell?: ShellLike }).AndroidShell;
    if (shell && typeof shell.openUrl === "function") {
        try {
            // 原生返回 true 表示已经交给系统；返回 false 才退回浏览器兜底
            if (shell.openUrl(url) !== false) return;
        } catch {
            // 原生调用异常也不能把点击吞掉，继续往下走 window.open
        }
    }
    window.open(url, "_blank", "noopener");
}
