/**
 * Minecraft 资源加速代理（Cloudflare Pages · Advanced Mode 单文件 Worker）
 * ==========================================================================
 *
 * 作用：把 Mojang 官方 CDN、Maven 仓库、模组站等上游资源，经 Cloudflare 的
 * 边缘节点缓存后再发给启动器/游戏/浏览器，从而绕开直连时的跨境限速。
 *
 * 三种写法（都指向同一个目标，任选一种）：
 *
 *   1) 主机名前缀（推荐，缓存键最干净，也方便直接塞进浏览器）
 *        https://<你的域名>/launchermeta.mojang.com/mc/game/version_manifest_v2.json
 *        https://<你的域名>/resources.download.minecraft.net/02/022e48...15e
 *
 *   2) 完整 URL 作为路径（ghproxy 风格，方便给别的工具填一个 base）
 *        https://<你的域名>/https://launchermeta.mojang.com/mc/game/version_manifest_v2.json
 *
 *   3) 查询参数（最不容易被路径转义搞坏）
 *        https://<你的域名>/p?url=https%3A%2F%2Fpiston-meta.mojang.com%2F...
 *
 *   4) BMCLAPI 兼容路径：以 / 开头且第一段不带点的路径，全部转发到
 *      BMCLAPI（/version/1.12.2/client、/maven/...、/assets/... 等）。
 *      这样它可以直接填进启动器「设置 → 下载源 → 自定义镜像」的地址里，
 *      等于给 BMCLAPI 套一层 Cloudflare 边缘缓存。
 *
 * 关键点（改代码前务必看懂）：
 *   - 必须原样转发 Range 并回 206 + Content-Range，否则启动器 32 线程分片下载
 *     会退化成单连接。这里对上游请求强制 `Accept-Encoding: identity`，这样缓存里
 *     存的是明文，命中缓存时才能安全地按 Range 切片。
 *   - 只代理白名单里的上游主机，避免变成公开开放代理被人拿去刷流量。
 *   - 响应体一律流式转发，不整体读进内存（缓存命中切片除外）。
 *
 * 部署（Cloudflare Pages）：
 *   1. 把本文件放在一个空目录里，文件名必须是 `_worker.js`。
 *   2. 仪表盘 → Workers & Pages → Create → Pages → Upload assets，
 *      把该目录拖进去发布（或 `npx wrangler pages deploy <目录>`）。
 *      Advanced Mode 下 Pages 会把所有请求交给这个 Worker，不需要别的文件。
 *   3. （可选）Pages 项目 → Settings → Variables and Secrets：
 *        PROXY_TOKEN          设了就要求调用方带 ?token=xxx 或 X-Proxy-Token 头
 *        EXTRA_ALLOWED_HOSTS  额外允许的主机，逗号分隔，例如 a.com,b.com
 *   4. 打开 https://<你的域名>/__health 自检。
 */

const VERSION = "1.0.0";

/** 允许代理的上游主机。不在列表里的一律 403。 */
const DEFAULT_ALLOWED_HOSTS = [
  // —— Mojang / Microsoft 官方资源 ——
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "launcher.mojang.com",
  "launchermeta.mojang.com",
  "resources.download.minecraft.net",
  "libraries.minecraft.net",
  // 微软商店版（Bedrock）分发域名
  "xboxlive.com",
  "displaycatalog.mp.microsoft.com",
  // —— 加载器 Maven / 元数据 ——
  "maven.minecraftforge.net",
  "files.minecraftforge.net",
  "maven.neoforged.net",
  "meta.fabricmc.net",
  "maven.fabricmc.net",
  "meta.quiltmc.org",
  "maven.quiltmc.org",
  "resources.betacraft.uk",
  "authlib-injector.yushi.moe",
  // —— 国内镜像（当作上游再套一层 CF 缓存）——
  "bmclapi2.bangbang93.com",
  "bmclapi.bangbang93.com",
  // —— 内容站 / 整合包 ——
  "api.modrinth.com",
  "cdn.modrinth.com",
  "api.curseforge.com",
  "edge.forgecdn.net",
  "media.forgecdn.net",
  // —— 加载器安装包常挂在 GitHub Releases ——
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
];

/** BMCLAPI 兼容路径的默认上游。 */
const BMCLAPI_ORIGIN = "https://bmclapi2.bangbang93.com";

/**
 * 缓存命中时允许在内存里切片的最大文件体积。
 *
 * Workers 免费方案单次请求只有 10ms CPU，把几十 MB 的缓存体拷一份就会超；
 * 超过这个体积的分片请求直接回源（Cloudflare 到上游的一跳），不自己切。
 */
const MAX_SLICE_BYTES = 32 * 1024 * 1024;

/** 从上游回传给调用方的响应头白名单；其余（set-cookie / server 等）一律丢弃。 */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "content-disposition",
  "content-language",
  "accept-ranges",
  "etag",
  "last-modified",
];

/** 按扩展名兜底的内容类型：有些 Maven 会回 octet-stream，浏览器/游戏会认错。 */
const CONTENT_TYPES = {
  jar: "application/java-archive",
  zip: "application/zip",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  ogg: "audio/ogg",
  lzma: "application/x-lzma",
  pack: "application/octet-stream",
};

// ---------------------------------------------------------------------------
// 纯函数：便于单独测试，不依赖 Workers 运行时
// ---------------------------------------------------------------------------

/** 逐条合并主机白名单：内置 + 环境变量里追加的。 */
export function allowedHosts(env) {
  const extra = String(env?.EXTRA_ALLOWED_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])];
}

export function isAllowedHost(host, env) {
  const name = String(host || "").toLowerCase();
  if (!name) return false;
  return allowedHosts(env).some(
    (allowed) => name === allowed || name.endsWith(`.${allowed}`),
  );
}

/**
 * 缓存时长（秒）。Mojang 的 objects 是内容寻址的（哈希即文件名），永远不会变，
 * 可以直接缓存一年；版本清单这类 JSON 变得快，只留 5 分钟。
 */
export function cacheTtlFor(pathname) {
  const path = String(pathname || "");
  if (/\/objects\//.test(path) || /\/[0-9a-f]{2}\/[0-9a-f]{40}$/i.test(path)) {
    return 31536000;
  }
  if (/\.(jar|zip|lzma|pack|ogg|mca|dll|so|dylib|exe|msi|dmg)$/i.test(path)) {
    return 2592000;
  }
  if (/\.(json|txt|xml|sha1|md5)$/i.test(path)) {
    return 300;
  }
  return 3600;
}

/**
 * 解析单段 Range。启动器的分片下载只发单段，所以多段/畸形 Range 直接返回
 * `null` 交回上游，别自己拼 multipart。
 *
 * 返回 {start, end} / "unsatisfiable" / null
 */
export function parseRange(header, total) {
  if (!header || !Number.isFinite(total) || total <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start;
  let end;
  if (!rawStart) {
    // bytes=-N：最后 N 个字节
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start >= total || start > end) return "unsatisfiable";
  return { start, end: Math.min(end, total - 1) };
}

/**
 * 把请求 URL 解析成上游地址。返回 {target} 或 {error, status}。
 * `token` 查询参数只用于鉴权，永远不进上游、也不进缓存键。
 */
export function resolveTarget(url) {
  const pathname = url.pathname;

  // /p?url=... 与 /proxy?url=...
  // 这条路径上的查询参数只属于代理本身（url、token），不能拼进上游地址，
  // 否则会让同一个文件产生无数个带垃圾参数的缓存条目。
  if (pathname === "/p" || pathname === "/proxy") {
    const raw = url.searchParams.get("url");
    if (!raw) return { error: "缺少 url 参数", status: 400 };
    let target;
    try {
      target = new URL(raw);
    } catch {
      return { error: "url 参数不是合法地址", status: 400 };
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return { error: "只支持 http(s) 上游", status: 400 };
    }
    return { target };
  }

  const params = new URLSearchParams(url.searchParams);
  params.delete("token");
  const query = params.toString();

  // /https://host/path 形式
  if (/^\/https?:\/\//i.test(pathname)) {
    try {
      const target = new URL(pathname.slice(1) + (query ? `?${query}` : ""));
      return { target };
    } catch {
      return { error: "路径里的 URL 不合法", status: 400 };
    }
  }

  // 主机名前缀：第一段带点即视为域名
  const first = pathname.split("/")[1] || "";
  if (first.includes(".")) {
    try {
      const target = new URL(
        `https://${pathname.slice(1)}${query ? `?${query}` : ""}`,
      );
      return { target };
    } catch {
      return { error: "路径里的主机名不合法", status: 400 };
    }
  }

  // 其余按 BMCLAPI 兼容路径处理
  return { target: new URL(`${BMCLAPI_ORIGIN}${pathname}${query ? `?${query}` : ""}`) };
}

/** 缓存键：去掉 token 等容易被随手改动的参数，避免同一文件被缓存多份。 */
export function cacheKeyFor(target) {
  const key = new URL(target.toString());
  key.searchParams.delete("token");
  key.hash = "";
  return new Request(key.toString(), { method: "GET" });
}

function contentTypeFor(target, upstreamType) {
  if (upstreamType && !/^application\/octet-stream/i.test(upstreamType)) {
    return upstreamType;
  }
  const ext = (target.pathname.split(".").pop() || "").toLowerCase();
  return CONTENT_TYPES[ext] || upstreamType || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Worker 入口
// ---------------------------------------------------------------------------

/** 所有响应都带上 CORS，浏览器里直接 fetch 资源（皮肤、音效、清单）不会卡住。 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range, if-range, x-proxy-token, content-type",
  "access-control-expose-headers":
    "content-length, content-range, accept-ranges, etag, x-proxy-cache",
  "access-control-max-age": "86400",
};

function textResponse(message, status, extra = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function helpPage(origin) {
  const example = `${origin}/launchermeta.mojang.com/mc/game/version_manifest_v2.json`;
  const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<title>Minecraft 资源加速代理</title>
<style>
  body{font:15px/1.7 system-ui,sans-serif;margin:0;padding:40px;background:#0d1117;color:#e6edf3}
  code{background:#161b22;padding:2px 6px;border-radius:5px;font-size:13px}
  pre{background:#161b22;padding:14px 16px;border-radius:10px;overflow:auto}
  h1{font-size:20px;margin:0 0 18px} a{color:#58a6ff} .muted{color:#8b949e}
  ul{padding-left:20px}
</style>
<h1>Minecraft 资源加速代理 · v${VERSION}</h1>
<p class="muted">Cloudflare Pages 边缘缓存，保留 Range 分片下载，带 CORS。</p>
<ul>
  <li>主机名前缀：<code>${origin}/resources.download.minecraft.net/02/022e48...15e</code></li>
  <li>完整 URL：<code>${origin}/https://piston-meta.mojang.com/mc/game/version_manifest_v2.json</code></li>
  <li>查询参数：<code>${origin}/p?url=&lt;编码后的地址&gt;</code></li>
  <li>BMCLAPI 兼容：<code>${origin}/version/1.12.2/client</code>（可直接填进启动器自定义镜像）</li>
</ul>
<pre>curl -I "${example}"</pre>
<p><a href="/__health">/__health</a> 查看允许的上游主机与状态。</p>
</html>`;
  return new Response(html, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}

/** 从缓存里的完整响应切出 Range 片段。缓存里是明文（identity），所以能安全切。
 *  返回 null 表示“这个请求别在本地切”，交给上游自己回 206。
 */
async function sliceCachedResponse(cached, rangeHeader, ttl) {
  const declared = Number(cached.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SLICE_BYTES) return null;
  const body = new Uint8Array(await cached.arrayBuffer());
  if (body.byteLength > MAX_SLICE_BYTES) return null;
  const total = body.byteLength;
  const range = parseRange(rangeHeader, total);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        ...CORS_HEADERS,
        "content-range": `bytes */${total}`,
        "x-proxy-cache": "HIT",
      },
    });
  }
  if (!range) {
    // 多段或畸形 Range：交回上游自己处理，别猜。
    return null;
  }
  const slice = body.subarray(range.start, range.end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      ...CORS_HEADERS,
      "content-type": cached.headers.get("content-type") || "application/octet-stream",
      "content-length": String(slice.byteLength),
      "content-range": `bytes ${range.start}-${range.end}/${total}`,
      "accept-ranges": "bytes",
      "cache-control": `public, max-age=${ttl}`,
      "x-proxy-cache": "HIT",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("只支持 GET / HEAD", 405, { allow: "GET, HEAD, OPTIONS" });
    }
    if (url.pathname === "/__health") {
      return new Response(
        JSON.stringify(
          {
            ok: true,
            version: VERSION,
            authRequired: Boolean(env?.PROXY_TOKEN),
            allowedHosts: allowedHosts(env),
          },
          null,
          2,
        ),
        {
          headers: {
            ...CORS_HEADERS,
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }
    if (url.pathname === "/" || url.pathname === "") {
      return helpPage(url.origin);
    }

    // 可选令牌：设了 PROXY_TOKEN 就必须带对，否则 401。
    const expected = env?.PROXY_TOKEN;
    if (expected) {
      const provided =
        request.headers.get("x-proxy-token") || url.searchParams.get("token") || "";
      if (provided !== expected) {
        return textResponse("令牌不正确", 401);
      }
    }

    const resolved = resolveTarget(url);
    if (resolved.error) {
      return textResponse(resolved.error, resolved.status || 400);
    }
    const { target } = resolved;
    if (!isAllowedHost(target.hostname, env)) {
      return textResponse(`主机不在白名单：${target.hostname}`, 403);
    }

    const ttl = cacheTtlFor(target.pathname);
    const rangeHeader = request.headers.get("range");
    const cache = caches.default;
    const cacheKey = cacheKeyFor(target);

    // 1) 命中缓存：有 Range 就切片，没有就直接回原文。
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        if (rangeHeader) {
          const sliced = await sliceCachedResponse(cached, rangeHeader, ttl);
          if (sliced) return sliced;
        } else {
          const headers = new Headers(cached.headers);
          for (const [name, value] of Object.entries(CORS_HEADERS)) {
            headers.set(name, value);
          }
          headers.set("x-proxy-cache", "HIT");
          return new Response(request.method === "HEAD" ? null : cached.body, {
            status: 200,
            headers,
          });
        }
      }
    } catch {
      // 缓存读失败不算错误，继续走上游。
    }

    // 2) 回源。强制 identity，缓存里存明文，Range 切片才安全。
    const upstreamHeaders = new Headers({
      "accept-encoding": "identity",
      "user-agent": `MCL-Proxy/${VERSION} (+cloudflare-pages)`,
    });
    if (rangeHeader) upstreamHeaders.set("range", rangeHeader);
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch) upstreamHeaders.set("if-none-match", ifNoneMatch);

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      });
    } catch (error) {
      return textResponse(`上游请求失败：${error?.message || error}`, 502);
    }

    const outHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) outHeaders.set(name, value);
    }
    outHeaders.set(
      "content-type",
      contentTypeFor(target, upstream.headers.get("content-type")),
    );
    outHeaders.set("accept-ranges", upstream.headers.get("accept-ranges") || "bytes");
    outHeaders.set("x-content-type-options", "nosniff");
    outHeaders.set("x-proxy-cache", "MISS");
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      outHeaders.set(name, value);
    }
    // 206 不写长缓存：分片响应的字节范围各不相同，交给上游/浏览器自己决定。
    outHeaders.set(
      "cache-control",
      upstream.status === 206 ? "public, max-age=0, must-revalidate" : `public, max-age=${ttl}`,
    );

    // 304 之类没有响应体，直接透传状态码。
    if (upstream.status === 304) {
      return new Response(null, { status: 304, headers: outHeaders });
    }

    const response = new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });

    // 3) 只把「完整 200 且不含 Set-Cookie」的响应写进边缘缓存。
    const canCache =
      request.method === "GET" &&
      upstream.status === 200 &&
      !rangeHeader &&
      !upstream.headers.get("set-cookie");
    if (canCache && ctx?.waitUntil) {
      try {
        const toCache = new Response(response.clone().body, {
          status: 200,
          headers: outHeaders,
        });
        ctx.waitUntil(cache.put(cacheKey, toCache));
      } catch {
        // 缓存写失败不影响本次下载。
      }
    }

    return response;
  },
};
