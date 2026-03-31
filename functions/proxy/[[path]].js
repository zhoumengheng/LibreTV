// functions/proxy/[[path]].js

// --- 配置 (现在从 Cloudflare 环境变量读取) ---
const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];

/**
 * 主要的 Pages Function 处理函数
 * 拦截发往 /proxy/* 的请求
 */
export async function onRequest(context) {
    const { request, env, next, waitUntil } = context;
    const url = new URL(request.url);

    // 验证鉴权
    const isValidAuth = await validateAuth(request, env);
    if (!isValidAuth) {
        return new Response(JSON.stringify({
            success: false,
            error: '代理访问未授权：请检查密码配置或鉴权参数'
        }), { 
            status: 401,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Content-Type': 'application/json'
            }
        });
    }

    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5');

    let USER_AGENTS = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    async function validateAuth(request, env) {
        const authHash = new URL(request.url).searchParams.get('auth');
        const timestamp = new URL(request.url).searchParams.get('t');
        const serverPassword = env.PASSWORD;
        if (!serverPassword) return false;
        
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(serverPassword);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const serverPasswordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            if (!authHash || authHash !== serverPasswordHash) return false;
        } catch (error) { return false; }
        
        if (timestamp) {
            const now = Date.now();
            if (now - parseInt(timestamp) > 600000) return false;
        }
        return true;
    }

    function logDebug(message) {
        if (DEBUG_ENABLED) console.log(`[Proxy Func] ${message}`);
    }

    function getTargetUrlFromPath(pathname) {
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            return decodeURIComponent(encodedUrl);
        } catch (e) { return null; }
    }

    function createResponse(body, status = 200, headers = {}) {
        const responseHeaders = new Headers(headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
        responseHeaders.set("Access-Control-Allow-Headers", "*");
        return new Response(body, { status, headers: responseHeaders });
    }

    function getBaseUrl(urlStr) {
        const parsedUrl = new URL(urlStr);
        return parsedUrl.origin + parsedUrl.pathname.substring(0, parsedUrl.pathname.lastIndexOf('/') + 1);
    }

    function resolveUrl(baseUrl, relativeUrl) {
        if (relativeUrl.match(/^https?:\/\//i)) return relativeUrl;
        return new URL(relativeUrl, baseUrl).toString();
    }

    function rewriteUrlToProxy(targetUrl) {
        return `/proxy/${encodeURIComponent(targetUrl)}`;
    }

    // --- 核心修复部分：fetchContentWithType ---
    async function fetchContentWithType(targetUrl) {
        const headers = new Headers({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        });

        // 针对豆瓣图片，彻底移除 Referer 强制绕过防盗链
        if (targetUrl.includes("doubanio.com")) {
            headers.delete("Referer");
        } else {
            headers.set('Referer', new URL(targetUrl).origin);
        }

        try {
            const response = await fetch(targetUrl, { headers, redirect: 'follow' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            // 检查是否是图片请求，如果是图片则直接返回 blob 避免文本解析损坏
            const contentType = response.headers.get('Content-Type') || '';
            if (contentType.startsWith('image/')) {
                return { content: await response.blob(), contentType, responseHeaders: response.headers, isImage: true };
            }

            const content = await response.text();
            return { content, contentType, responseHeaders: response.headers, isImage: false };
        } catch (error) {
            throw new Error(`Fetch failed: ${error.message}`);
        }
    }

    function isM3u8Content(content, contentType) {
        return (contentType && contentType.includes('mpegurl')) || (typeof content === 'string' && content.trim().startsWith('#EXTM3U'));
    }

    // M3U8 处理逻辑保持不变...
    function processMediaPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        return content.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            return rewriteUrlToProxy(resolveUrl(baseUrl, trimmed));
        }).join('\n');
    }

    try {
        const targetUrl = getTargetUrlFromPath(url.pathname);
        if (!targetUrl) return createResponse("Invalid Path", 400);

        const { content, contentType, responseHeaders, isImage } = await fetchContentWithType(targetUrl);

        if (!isImage && isM3u8Content(content, contentType)) {
            const processedM3u8 = processMediaPlaylist(targetUrl, content);
            return new Response(processedM3u8, {
                headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*" }
            });
        } else {
            const finalHeaders = new Headers(responseHeaders);
            finalHeaders.set("Access-Control-Allow-Origin", "*");
            // 增加安全策略抹除，双重保险
            finalHeaders.set("Referrer-Policy", "no-referrer"); 
            return new Response(content, { status: 200, headers: finalHeaders });
        }
    } catch (error) {
        return createResponse(error.message, 500);
    }
}

export async function onOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
        },
    });
}