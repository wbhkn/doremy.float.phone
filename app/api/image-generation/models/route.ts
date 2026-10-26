import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

type ModelListRequest = {
  apiKey?: string;
  baseUrl?: string;
};

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "");
}

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/models$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/models`;
}

function extractModels(data: unknown): string[] {
  const results: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/^models\//, "").trim();
    if (normalized) results.push(normalized);
  };

  if (Array.isArray(data)) {
    data.forEach(item => {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        push(row.id ?? row.name ?? row.model);
      }
    });
  } else if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    for (const key of ["data", "models", "items"]) {
      const value = row[key];
      if (Array.isArray(value)) results.push(...extractModels(value));
    }
    push(row.id ?? row.name ?? row.model);
  }

  return Array.from(new Set(results));
}

const HTML_ERROR_RE = /^\s*<(?:!doctype|html|head|body)/i;

function friendlyInterfaceError(status: number, url: string): string {
  if (/ngrok/i.test(url)) {
    return `模型列表返回的是 ngrok 的网页（HTTP ${status}）：这条 ngrok 隧道现在没连到你的服务——要么隧道已经断开，要么免费版重启后地址变了。请重新启动 ngrok，把新的 https 地址填回 Base URL。`;
  }
  return `模型列表返回的是网页而不是 JSON（HTTP ${status}）：地址可能填错，或指到了登录页/提示页。请确认 Base URL 是接口根路径。`;
}

async function externalFetch(url: string, init: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  const headers = new Headers(init.headers || {});
  if (/ngrok/i.test(url) && !headers.has("ngrok-skip-browser-warning")) {
    headers.set("ngrok-skip-browser-warning", "true");
  }
  const nextInit: RequestInit = { ...init, headers };
  return dispatcher
    ? undiciFetch(url, { ...(nextInit as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as Response
    : fetch(url, nextInit);
}

export async function POST(req: NextRequest) {
  try {
    const input = await req.json() as ModelListRequest;
    const apiKey = input.apiKey?.trim();
    const baseUrl = input.baseUrl?.trim();
    if (!apiKey) return NextResponse.json({ error: "缺少 API Key" }, { status: 400 });
    if (!baseUrl) return NextResponse.json({ error: "缺少 Base URL" }, { status: 400 });

    const modelsUrl = buildModelsUrl(baseUrl);
    const res = await externalFetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok || HTML_ERROR_RE.test(text)) {
      if (HTML_ERROR_RE.test(text)) {
        return NextResponse.json({ error: friendlyInterfaceError(res.status, modelsUrl) }, { status: 502 });
      }
      return NextResponse.json({ error: `模型列表 API 错误 ${res.status}: ${text.slice(0, 400)}` }, { status: 502 });
    }

    const parsed = JSON.parse(text);
    return NextResponse.json({ models: extractModels(parsed) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
