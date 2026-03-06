/*
 * YouTube 双字幕 v4.7
 *
 * 策略：
 *   http-request：把 URL 里的 fmt=srv3 改成 fmt=json3，让 YouTube 返回句级字幕
 *   http-response：收到 json3 后翻译并合成双行，返回给 App
 *
 *   这样 App 从一开始就只知道 json3，不存在 srv3 缓存问题。
 */

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

if (typeof $response === "undefined") {
  handleRequest();
} else {
  handleResponse();
}

// ══════════════════════════════════════════════════════════════════════════════
// REQUEST：把 srv3 改成 json3
// ══════════════════════════════════════════════════════════════════════════════
function handleRequest() {
  const url = $request.url;
  console.log("[YTDual] REQ " + url.slice(0, 100));

  // 把 format=srv3 / fmt=srv3 / format=srv1 等全部改成 fmt=json3
  let newUrl = url
    .replace(/([?&])format=[^&]*/g, "$1fmt=json3")
    .replace(/([?&])fmt=[^&]*/g,    "$1fmt=json3");

  // 如果 URL 里完全没有 fmt 参数，加上
  if (!newUrl.includes("fmt=")) {
    newUrl += "&fmt=json3";
  }

  if (newUrl !== url) {
    console.log("[YTDual] 改为 json3: " + newUrl.slice(0, 120));
    $done({ url: newUrl });
  } else {
    $done({});
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// RESPONSE：翻译并合成双行 json3
// ══════════════════════════════════════════════════════════════════════════════
function handleResponse() {
  const url  = $request.url;
  const body = $response.body;

  console.log("[YTDual] RESP 长度=" + (body||"").length + " 前30=" + (body||"").slice(0,30));

  if (!body || body.length < 10) { $done({}); return; }

  const fmt = detectFormat(body);
  console.log("[YTDual] 格式=" + fmt);
  if (fmt === "unknown") { $done({}); return; }

  const params  = parseURLParams(url);
  const videoId = params.v || params.videoId || "";
  if (!videoId) { $done({}); return; }

  (async () => {
    try {
      const cacheKey = "YTDual47_" + videoId + "_" + TARGET_LANG;
      let transMap   = readCache(cacheKey);

      if (transMap) {
        console.log("[YTDual] 缓存命中 " + Object.keys(transMap).length + " 条");
      } else {
        // 提取字幕条目
        const entries = extractEntries(body, fmt);
        console.log("[YTDual] 提取 " + entries.length + " 条");
        if (!entries.length) { $done({}); return; }

        // 翻译
        transMap = await translateAll(entries, TARGET_LANG);
        console.log("[YTDual] 翻译 " + Object.keys(transMap).length + " 条");
        if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
      }

      // 合成双行
      const result = composeDual(body, fmt, transMap, LAYOUT);

      // 修正响应头（去掉 gzip，避免 App 二次解压出错）
      const headers = cleanHeaders($response.headers || {});
      console.log("[YTDual] ✅ 返回");
      $done({ body: result, headers });

    } catch(e) {
      console.log("[YTDual] 异常: " + e.message);
      $done({});
    }
  })();
}

// ══════════════════════════════════════════════════════════════════════════════
// 提取字幕条目
// ══════════════════════════════════════════════════════════════════════════════
function extractEntries(body, fmt) {
  const entries = [];
  if (fmt === "json3") {
    try {
      const data = JSON.parse(body);
      for (const e of (data.events || [])) {
        if (!Array.isArray(e.segs)) continue;
        const text = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(e.tStartMs||0), text });
      }
    } catch(e) { console.log("[YTDual] json3 解析失败: " + e.message); }
  } else if (fmt === "xml") {
    let m;
    const pRe = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
    while ((m = pRe.exec(body)) !== null) {
      const text = decodeHTML(m[2].replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
      if (text) entries.push({ key: m[1], text });
    }
    if (!entries.length) {
      const tRe = /<text\b[^>]*\bstart="([^"]*)"[^>]*>([\s\S]*?)<\/text>/gi;
      while ((m = tRe.exec(body)) !== null) {
        const ms = Math.round(parseFloat(m[1])*1000);
        const text = decodeHTML(m[2].replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(ms), text });
      }
    }
  }
  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// 合成双行
// ══════════════════════════════════════════════════════════════════════════════
function composeDual(body, fmt, map, layout) {
  if (fmt === "json3") {
    let data;
    try { data = JSON.parse(body); } catch(e) { return body; }
    let hit = 0;
    for (const e of (data.events || [])) {
      if (!Array.isArray(e.segs)) continue;
      const orig  = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
      if (!orig) continue;
      const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
      if (!trans || trans === orig) continue;
      e.segs = [{ utf8: makeLine(orig, trans, layout) }];
      hit++;
    }
    console.log("[YTDual] json3 合成 " + hit + " 条");
    return JSON.stringify(data);
  }
  if (fmt === "xml") {
    let hit = 0;
    let result = body.replace(/<p\b([^>]*\bt="(\d+)"[^>]*)>([\s\S]*?)<\/p>/gi,
      (full, attrs, ms, content) => {
        const orig  = decodeHTML(content.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
        if (!orig) return full;
        const trans = map[ms] || fuzzyGet(map, parseInt(ms));
        if (!trans || trans === orig) return full;
        hit++;
        return "<p" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</p>";
      }
    );
    if (!hit) {
      result = body.replace(/<text\b([^>]*\bstart="([^"]*)"[^>]*)>([\s\S]*?)<\/text>/gi,
        (full, attrs, s, content) => {
          const ms   = Math.round(parseFloat(s)*1000);
          const orig = decodeHTML(content.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
          if (!orig) return full;
          const trans = map[String(ms)] || fuzzyGet(map, ms);
          if (!trans || trans === orig) return full;
          hit++;
          return "<text" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</text>";
        }
      );
    }
    console.log("[YTDual] xml 合成 " + hit + " 条");
    return result;
  }
  return body;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

function cleanHeaders(h) {
  const out = {};
  for (const k of Object.keys(h)) {
    const kl = k.toLowerCase();
    if (kl === "content-encoding" || kl === "content-length") continue;
    out[k] = h[k];
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// 批量翻译
// ══════════════════════════════════════════════════════════════════════════════
const SEP = "\n❖\n", CHUNK_MAX = 3500;

async function translateAll(entries, tl) {
  const map = {};
  const chunks = [];
  let cur = [], curLen = 0;
  for (const e of entries) {
    const len = e.text.length + SEP.length;
    if (curLen + len > CHUNK_MAX && cur.length) { chunks.push(cur); cur=[]; curLen=0; }
    cur.push(e); curLen += len;
  }
  if (cur.length) chunks.push(cur);
  console.log("[YTDual] " + chunks.length + " 批翻译");
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    try {
      const translated = await googleTranslate(chunk.map(e=>e.text).join(SEP), tl);
      translated.split(/❖/).forEach((t,i) => {
        const clean = t.trim();
        if (clean && chunk[i]) map[chunk[i].key] = clean;
      });
      console.log("[YTDual] 批次" + (ci+1) + " 完成");
    } catch(e) { console.log("[YTDual] 批次" + (ci+1) + " 失败: " + e.message); }
  }
  return map;
}

function googleTranslate(text, tl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("超时")), 15000);
    $httpClient.post({
      url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(tl) + "&dt=t&dj=1",
      headers: { "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"GoogleTranslate/6.29.59279 (iPhone; iOS 15.4; en; iPhone14,2)" },
      body: "q=" + encodeURIComponent(text),
    }, (err,_r,rb) => {
      clearTimeout(timer);
      if (err) { reject(new Error(String(err))); return; }
      try {
        const d = JSON.parse(rb);
        if (Array.isArray(d.sentences)) resolve(d.sentences.map(s=>s.trans||"").join("").trim());
        else reject(new Error("格式异常"));
      } catch(e) { reject(e); }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════════════════════════
function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{"))      return "json3";
  if (t.startsWith("WEBVTT")) return "webvtt";
  if (t.startsWith("<"))      return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 500) return map[k];
  }
  return null;
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

function readCache(key) {
  try { const r=$persistentStore.read(key); return r?JSON.parse(r):null; } catch(_){return null;}
}

function writeCache(key, obj) {
  try { $persistentStore.write(JSON.stringify(obj), key); } catch(_){}
}

function decodeHTML(s) {
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
}

function encodeHTML(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
