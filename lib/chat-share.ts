export type MusicChatSharePayload = {
    type: "music";
    title: string;
    artist: string;
};

export type XiaohongshuNoteChatSharePayload = {
    type: "xiaohongshu_note";
    authorName: string;
    title: string;
    body: string;
    description?: string;
    noteType: "post" | "video";
    tags?: string[];
    imageAssetId?: string;
    coverIcon?: string;
    tone?: string;
};

export type ChatSharePayload = MusicChatSharePayload | XiaohongshuNoteChatSharePayload;

function compactShareText(value: string | undefined, fallback: string): string {
    const text = (value || "").replace(/\s+/g, " ").trim();
    return text || fallback;
}

export function formatXiaohongshuShareForPrompt(input: {
    author?: string;
    title?: string;
    body?: string;
    description?: string;
}): string {
    const author = compactShareText(input.author, "未知作者");
    const title = compactShareText(input.title, "无标题");
    const body = compactShareText(input.body, "无正文内容");
    const description = compactShareText(input.description, "");
    return `分享了一条小红书帖子，作者：${author}, 标题：${title}, 正文内容：${body}，图片/视频描述：${description || "无"}`;
}

/**
 * B 站视频分享给模型看的样子。
 *
 * 关键：把真实标题/UP 写进上下文——否则角色只能对着一串链接瞎猜，
 * 或者（更糟）自己编一个视频标题出来。
 */
export function formatBilibiliShareForPrompt(input: {
    bvid?: string;
    title?: string;
    up?: string;
    duration?: string;
    view?: number;
}): string {
    const title = compactShareText(input.title, "（标题还没取到）");
    const up = compactShareText(input.up, "未知UP主");
    const duration = compactShareText(input.duration, "");
    const view = Number(input.view) || 0;
    const viewLabel = view >= 10000 ? `${(view / 10000).toFixed(1)}万` : String(view);
    const parts = [`分享了一条B站视频，标题：${title}`, `UP主：${up}`];
    if (duration) parts.push(`时长：${duration}`);
    if (view > 0) parts.push(`播放：${viewLabel}`);
    if (input.bvid) parts.push(`链接：https://www.bilibili.com/video/${input.bvid}`);
    parts.push("（你可以直接聊这条视频的内容，需要细节时用「刷B站」能力按这个 BV 号查简介和评论）");
    return parts.join("；");
}
