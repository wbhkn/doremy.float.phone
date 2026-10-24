// comfy-proxy: 稳定的生图入口（带 x-bridge-token 校验）
// 外部调用: https://<project-ref>.supabase.co/functions/v1/comfy-proxy/v1/images/generations
// 目标地址存在 public.comfy_bridge_config(id=1).target_url，隧道换了只改这张表，不用改 App 配置。
//
// 鉴权：请求必须带上 BRIDGE_TOKEN（Supabase 函数密钥）之一：
//   - x-bridge-token: <token>
//   - Authorization: Bearer <token>   （App 里把这一串填到「API Key」即可）
// 校验通过后，函数会把服务器上的令牌注入到转发请求里，本地桥接同样校验该令牌。
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, X-Bridge-Token, apikey, *",
  "Access-Control-Max-Age": "86400",
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

function readClientToken(req: Request): string {
  const direct = (req.headers.get("x-bridge-token") || "").trim();
  if (direct) return direct;
  const auth = (req.headers.get("authorization") || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

async function getTarget(): Promise<string> {
  const base = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${base}/rest/v1/comfy_bridge_config?id=eq.1&select=target_url`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`config read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("comfy_bridge_config has no row 1");
  return String(rows[0].target_url);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const expected = (Deno.env.get("BRIDGE_TOKEN") || "").trim();
  if (expected) {
    const got = readClientToken(req);
    if (!got || got !== expected) {
      return jsonError(401, "invalid bridge token");
    }
  }

  const url = new URL(req.url);
  let sub = url.pathname;
  for (const prefix of ["/functions/v1/comfy-proxy", "/comfy-proxy"]) {
    if (sub.startsWith(prefix)) {
      sub = sub.slice(prefix.length);
      break;
    }
  }
  if (!sub.startsWith("/")) sub = "/" + sub;

  let target: string;
  try {
    target = await getTarget();
  } catch (e) {
    return jsonError(500, String(e));
  }

  const dest = target.replace(/\/+$/, "") + sub + url.search;
  const headers = new Headers();
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  if (expected) headers.set("x-bridge-token", expected);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  try {
    const upstream = await fetch(dest, { method: req.method, headers, body });
    const out = new Headers(cors);
    const upCt = upstream.headers.get("content-type");
    if (upCt) out.set("content-type", upCt);
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
  } catch (e) {
    return jsonError(502, `upstream ${dest} failed: ${e}`);
  }
});
