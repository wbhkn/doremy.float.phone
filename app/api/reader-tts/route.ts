import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";

type Body = {
  text?: string;
  apiKey?: string;
  baseUrl?: string;
  voiceId?: string;
  model?: string;
  speed?: number;
};

/**
 * 浮读听书：把 MiniMax 的 t2a_v2 包一层，返回真正的 mp3 二进制。
 *
 * 为什么不在浏览器里直连 MiniMax：
 * 1) 浏览器直连会被 CORS 拦；2) t2a_v2 返回的是 hex 编码的音频，解起来麻烦；
 * 3) 密钥从网页设置里读出来后只往这里传，不落到第三方域名。
 *
 * 密钥来源：小手机「设置 → 语音」里已经配好的 MiniMax 语音配置
 * （kv key `ai_phone_voice_configs_v1`），由前端读取后随请求带上。
 */
export async function POST(request: Request) {
  let body: Body | null = null;
  try {
    body = (await request.json()) as Body;
  } catch {
    body = null;
  }

  const text = String(body?.text || "").trim();
  const apiKey = String(body?.apiKey || "").trim();
  const baseUrl = (String(body?.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  const voiceId = String(body?.voiceId || "female-shaonv").trim();
  const model = String(body?.model || "speech-2.8-turbo").trim();
  const speed = Number.isFinite(Number(body?.speed)) ? Number(body?.speed) : 1;

  if (!text) return NextResponse.json({ ok: false, error: "缺少文本" }, { status: 400 });
  if (!apiKey) return NextResponse.json({ ok: false, error: "还没有可用的 MiniMax 密钥" }, { status: 400 });
  if (text.length > 1200) return NextResponse.json({ ok: false, error: "单次文本太长" }, { status: 400 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const upstream = await fetch(`${baseUrl}/t2a_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        voice_setting: { voice_id: voiceId, speed: Math.min(2, Math.max(0.5, speed)), vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      }),
      signal: controller.signal,
    });
    const payload = (await upstream.json().catch(() => null)) as
      | { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string }; status_code?: number; status_msg?: string }
      | null;

    const code = payload?.base_resp?.status_code ?? payload?.status_code;
    const message = payload?.base_resp?.status_msg || payload?.status_msg || "";
    if (!upstream.ok || (typeof code === "number" && code !== 0)) {
      return NextResponse.json(
        { ok: false, error: message || `上游返回 ${upstream.status}` },
        { status: 502 },
      );
    }
    const hex = payload?.data?.audio;
    if (!hex) return NextResponse.json({ ok: false, error: "上游没有返回音频" }, { status: 502 });

    const bytes = Buffer.from(hex, "hex");
    if (!bytes.length) return NextResponse.json({ ok: false, error: "音频为空" }, { status: 502 });
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return NextResponse.json(
      { ok: false, error: aborted ? "语音合成超时" : "语音合成失败" },
      { status: 504 },
    );
  } finally {
    clearTimeout(timer);
  }
}
