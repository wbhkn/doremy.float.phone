import { NextResponse } from "next/server";

import { runBiliAction } from "@/lib/bilibili-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * B 站公开数据代理。网页/WebView 不能直连 api.bilibili.com（没有 CORS 头），
 * 所以角色的「刷B站」工具统一打这个同源接口。
 *
 * GET /api/bili/popular?ps=10
 * GET /api/bili/ranking?rid=0
 * GET /api/bili/search?keyword=星海&page=1
 * GET /api/bili/video?bvid=BV1xx411c7mD
 * GET /api/bili/comments?bvid=…（或 aid=…）
 * GET /api/bili/related?bvid=…
 * GET /api/bili/online?bvid=…
 * GET /api/bili/user?mid=2
 */
export async function GET(request: Request, { params }: { params: Promise<{ action: string }> }) {
    const { action } = await params;
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
        query[key] = value;
    });

    const result = await runBiliAction(action, query);
    return NextResponse.json(result, {
        status: result.ok ? 200 : 200,
        headers: {
            "Cache-Control": "no-store",
        },
    });
}
