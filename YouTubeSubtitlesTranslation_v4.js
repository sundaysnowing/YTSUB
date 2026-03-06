/*
 * YouTube 双字幕 v4.5
 *
 * 核心策略：
 *   拦截到任何格式的字幕请求后，统一换成 json3 格式返回。
 *   json3 是 YouTube 官方支持的格式，按完整句子切分，不会出现逐词重叠。
 *   同时修改响应头 content-type，确保 App 正确解析。
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] 触发 url=" + url.slice(0, 100));

if (!body || body.length < 10) { $done({}); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";

if (!videoId) { $done({}); return; }
console.log("[YTDual] videoId=" + videoId + " lang=" + TARGET_LANG);

(async () => {
  try {
    const cacheKey     = "YTDual4_" + videoId + "_" + TARGET_LANG;
    const cacheKeyJ3   = "YTDual4_" + videoId + "_json3";
    let transMap  = readCache(cacheKey);
    let json3Body = readCache(cacheKeyJ3);  // 缓存原始 json3 文本

    if (transMap && json3Body) {
      console.log("[YTDual] 全部命中缓存");
    } else {
      // ── 请求 json3 格式字幕 ────────────────────────────────────────────────
      const json3Url = buildJSON3Url(url, params);
      console.log("[YTDual] 请求 json3: " + json3Url.slice(0, 120));

      try {
        json3Body = await httpGet(json3Url);
        console.log("[YTDual] json3 长度=" + json3Body.length + " 前20=" + json3Body.slice(0,20));
      } catch(e) {
        console.log("[YTDual] json3 请求失败: " + e.message);
        $done({});
        return;
      }

      // 验证是合法的 json3
      let json3Data;
      try {
        json3Data = JSON.parse(json3Body);
      } catch(e) {
        console.log("[YTDual] json3 解析失败，body前100: " + json3Body.slice(0,100));
        $done({});
        return;
      }

      // 提取句级字幕条目
      const entries = [];
      for (const e of (json3Data.events || [])) {
        if (!Array.isArray(e.segs)) continue;
        const text = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(e.tStartMs||0), text });
      }
      console.log("[YTDual] 提取 " + entries.length + " 条句级字幕");

      if (!entries.length) { $done({}); return; }

      // 翻译
      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] 翻译 " + Object.keys(transMap).length + " 条完成");

      if (Object.keys(transMap).length > 0) {
        writeCache(cacheKey, transMap);
        writeCache(cacheKeyJ3, json3Body);
      }
    }

    // ── 合成双行 json3 ────────────────────────────────────────────────────────
    let json3Data;
    try { json3Data = JSON.parse(json3Body); } catch(e) { $done({}); return; }

    let hit = 0;
    for (const e of (json3Data.events || [])) {
      if (!Array.isArray(e.segs)) continue;
      const orig = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
      if (!orig) continue;
      const trans = transMap[String(e.tStartMs)] || fuzzyGet(transMap, e.tStartMs);
      if (!trans || trans === orig) continue;
      e.segs = [{ utf8: makeLine(orig, trans, LAYOUT) }];
      hit++;
    }
    console.log("[YTDual] ✅ 合成 " + hit + " 条，返回 json3");

    // ── 修改响应头，告知 App 这是 json3 ──────────────────────────────────────
    const newHeaders = {};
    const origHeaders = $response.headers || {};
    for (const k of Object.keys(origHeaders)) {
      const kl = k.toLowerCase();
      // 去掉 content-encoding（不能再 gzip，因为我们返回明文）
      if (kl === "content-encoding") continue;
      // 去掉 content-length（长度变了）
      if (kl === "content-length") continue;
      newHeaders[k] = origHeaders[k];
    }
    newHeaders["content-type"] = "application/json; charset=UTF-8";

    $done({ body: JSON.stringify(json3Data), headers: newHeaders });

  } catch(e) {
    console.log("[YTDual] 异常: " + e.message);
    $done({});
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 构造 json3 URL
// ══════════════════════════════════════════════════════════════════════════════
function buildJSON3Url(origUrl, params) {
  const strip = new Set([
    "seek_to_segment_start","seg","xorb","xobt","xovt","asr_langs",
    "cbr","cbrver","c","cver","cplayer","cos","cosver","cplatform","cpn"
  ]);
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (strip.has(k) || k === "fmt" || k === "format") continue;
    parts.push(k + "=" + encodeURIComponent(v));
  }
  parts.push("fmt=json3");
  return "https://www.youtube.com/api/timedtext?" + parts.join("&");
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
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
      console.log("[YTDual] 批次" + (ci+1) + " OK，首句: " + translated.slice(0,30));
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
function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 500) return map[k];
  }
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("超时")), 15000);
    $httpClient.get({ url, headers:{"User-Agent":"com.google.ios.youtube/19.45.4 (iPhone; iOS 17.0)"} },
      (err,_r,b) => { clearTimeout(timer); if(err) reject(new Error(String(err))); else resolve(b); });
  });
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
