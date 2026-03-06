/*
 * YouTube 双字幕 v6.0
 *
 * 完全参考 kelee 方案：
 * 不碰 srv3 内容，改在 player 请求阶段修改字幕 URL
 *
 * 流程：
 * 1. http-request 拦截 /youtubei/v1/player 响应体（JSON）
 *    找到所有字幕 URL，加上 &tlang=zh-Hans 让 YouTube 返回中文机翻
 *    同时保存原始字幕 URL 到缓存
 *
 * 2. http-response 拦截 /api/timedtext
 *    如果是带 tlang 的请求（译文），主动抓一份原文，合并双行返回
 *    如果是原文请求，原样返回
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

// ── 判断当前阶段 ──────────────────────────────────────────────────────────────
if (typeof $response === "undefined") {
  handlePlayerRequest();
} else {
  handleTimedTextResponse();
}

// ══════════════════════════════════════════════════════════════════════════════
// 阶段1：拦截 player 请求，修改字幕 URL 加 tlang
// ══════════════════════════════════════════════════════════════════════════════
function handlePlayerRequest() {
  const url  = $request.url;
  const body = $request.body;
  if (!body) { $done({}); return; }

  console.log("[YTDual] player REQ url=" + url.slice(0,60));

  try {
    // player 响应体是 JSON，找到字幕 baseUrl 并加 tlang
    // 同时把原始 URL 存起来供 response 阶段用
    let modified = body;
    let count = 0;

    // 匹配所有 timedtext URL
    modified = modified.replace(
      /(https?:\\\/\\\/[^"]*?\\\/api\\\/timedtext[^"]*?)"/g,
      (match, captureUrl) => {
        // 解码 JSON 转义
        const decoded = captureUrl.replace(/\\\//g, "/");
        if (decoded.includes("tlang=")) return match; // 已有 tlang，跳过

        const tlang = TARGET_LANG === "zh-Hans" ? "zh-Hans"
                    : TARGET_LANG === "zh-Hant" ? "zh-Hant"
                    : TARGET_LANG;
        const newUrl = decoded + "&tlang=" + encodeURIComponent(tlang);
        // 重新 JSON 转义
        const encoded = newUrl.replace(/\//g, "\\/");
        count++;
        return encoded + '"';
      }
    );

    console.log("[YTDual] player 修改了 " + count + " 个字幕 URL");
    if (count > 0) {
      $done({ body: modified });
    } else {
      $done({});
    }
  } catch(e) {
    console.log("[YTDual] player ERR: " + e.message);
    $done({});
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 阶段2：拦截 timedtext 响应，合并原文和译文
// ══════════════════════════════════════════════════════════════════════════════
function handleTimedTextResponse() {
  const url  = $request.url;
  let   body = $response.body;

  console.log("[YTDual] timedtext RESP len=" + (body||"").length);

  function safeReturn(b) { $done({ body: b || body }); }

  if (!body || body.length < 10) { safeReturn(body); return; }

  // 只处理带 tlang 的请求（这是我们加的译文请求）
  if (!url.includes("tlang=")) { safeReturn(body); return; }

  const fmt = detectFormat(body);
  if (fmt === "unknown") { safeReturn(body); return; }

  const params  = parseURLParams(url);
  const videoId = params.v || params.videoId || "";
  if (!videoId) { safeReturn(body); return; }

  // 剥离 <s> 标签
  if (fmt === "xml") body = body.replace(/<\/?s\b[^>]*>/g, "");

  (async () => {
    try {
      // 构造原文 URL（去掉 tlang）
      const origUrl = url.replace(/&tlang=[^&]*/g, "");
      console.log("[YTDual] 抓原文: " + origUrl.slice(0,100));

      let origBody;
      try {
        origBody = await httpGet(origUrl);
        if (fmt === "xml") origBody = origBody.replace(/<\/?s\b[^>]*>/g, "");
        console.log("[YTDual] 原文 len=" + origBody.length);
      } catch(e) {
        console.log("[YTDual] 原文抓取失败: " + e.message);
        safeReturn(body); return;
      }

      // 合并：origBody = 英文，body = 中文译文
      const result = mergeSubtitles(origBody, body, fmt, LAYOUT);
      safeReturn(result);

    } catch(e) {
      console.log("[YTDual] timedtext ERR: " + e.message);
      safeReturn(body);
    }
  })();
}

// ══════════════════════════════════════════════════════════════════════════════
// 合并原文和译文
// ══════════════════════════════════════════════════════════════════════════════
function mergeSubtitles(origBody, transBody, fmt, layout) {
  if (fmt === "json3") {
    try {
      const origData  = JSON.parse(origBody);
      const transData = JSON.parse(transBody);

      // 建立译文 map
      const transMap = {};
      for (const e of (transData.events||[])) {
        if (!e.segs) continue;
        const t = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (t) transMap[String(e.tStartMs||0)] = t;
      }

      // 写入原文
      for (const e of (origData.events||[])) {
        if (!e.segs) continue;
        const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (!orig) continue;
        const trans = transMap[String(e.tStartMs||0)] || fuzzyGet(transMap, e.tStartMs);
        if (trans && trans !== orig) {
          e.segs = [{ utf8: makeLine(orig, trans, layout) }];
        }
      }
      return JSON.stringify(origData);
    } catch(e) { return origBody; }
  }

  if (fmt === "xml") {
    // 建立译文 map：时间戳 -> 文本
    const transMap = {};
    transBody.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (_, attrs, content) => {
      if (/\ba=["']?1["']?/.test(attrs)) return;
      const tM = attrs.match(/\bt="(\d+)"/);
      if (!tM) return;
      const text = decodeHTML(content).replace(/\s+/g," ").trim();
      if (text) transMap[tM[1]] = text;
    });

    console.log("[YTDual] transMap=" + Object.keys(transMap).length);

    // 写入原文
    let hit = 0;
    const result = origBody.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (full, attrs, content) => {
      if (/\ba=["']?1["']?/.test(attrs)) return full;
      const tM = attrs.match(/\bt="(\d+)"/);
      if (!tM) return full;
      const orig = decodeHTML(content).replace(/\s+/g," ").trim();
      if (!orig) return full;
      const trans = transMap[tM[1]] || fuzzyGet(transMap, parseInt(tM[1]));
      if (!trans) return full;
      hit++;
      return "<p" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</p>";
    });
    console.log("[YTDual] merge hit=" + hit);
    return result;
  }

  return origBody;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

// ── 工具 ──────────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    $httpClient.get({ url, headers:{"User-Agent":"com.google.ios.youtube/19.45.4 (iPhone; iOS 17.0)"} },
      (err,_r,b) => { clearTimeout(timer); if(err) reject(new Error(String(err))); else resolve(b||""); });
  });
}

function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{")) return "json3";
  if (t.startsWith("<")) return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  let best = null, bestDiff = 400;
  for (const k of Object.keys(map)) {
    const diff = Math.abs(Number(k) - t);
    if (diff < bestDiff) { bestDiff = diff; best = map[k]; }
  }
  return best;
}

function parseURLParams(url) {
  const obj={}, qi=url.indexOf("?"); if(qi<0) return obj;
  url.slice(qi+1).split("&").forEach(p=>{
    const eq=p.indexOf("="); if(eq<0) return;
    try{obj[decodeURIComponent(p.slice(0,eq))]=decodeURIComponent(p.slice(eq+1));}catch(_){}
  }); return obj;
}

function parseArgs(str) {
  const obj={}; if(!str) return obj;
  str.split("&").forEach(p=>{ const eq=p.indexOf("="); if(eq<0) return;
    try{obj[decodeURIComponent(p.slice(0,eq))]=decodeURIComponent(p.slice(eq+1));}catch(_){} }); return obj;
}

function decodeHTML(s) {
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c));
}
function encodeHTML(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
