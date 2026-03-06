/*
 * YouTube 双字幕 v4.3
 *
 * 核心策略：
 *   YouTube App 请求的是 srv3（逐词字幕），直接处理会造成句子割裂。
 *   本脚本拦截到请求后，主动用 json3 格式重新抓同一视频的完整句级字幕，
 *   翻译后以 json3 格式返回给 App，完全替换 srv3 响应。
 *   json3 是 YouTube 官方格式，App 完全支持。
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] 触发 url=" + url.slice(0, 100));

if (!body || body.length < 10) { $done({}); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f"; // f=中文上英文下

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";

console.log("[YTDual] videoId=" + videoId + " targetLang=" + TARGET_LANG);

if (!videoId) { $done({}); return; }

(async () => {
  try {
    const cacheKey = "YTDual_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (transMap) {
      console.log("[YTDual] 命中缓存 " + Object.keys(transMap).length + " 条");
    } else {
      // ── 主动抓 json3 格式的完整句级字幕 ────────────────────────────────────
      const json3Url = buildJSON3Url(url, params);
      console.log("[YTDual] 抓 json3: " + json3Url.slice(0, 120));

      let json3Body;
      try {
        json3Body = await httpGet(json3Url);
        console.log("[YTDual] json3 长度=" + json3Body.length + " 前30=" + json3Body.slice(0, 30));
      } catch (e) {
        console.log("[YTDual] json3 请求失败: " + e.message);
        $done({});
        return;
      }

      // 解析 json3 字幕
      const entries = extractJSON3(json3Body);
      console.log("[YTDual] 解析到 " + entries.length + " 条句级字幕");

      if (!entries.length) {
        console.log("[YTDual] 无字幕，退出");
        $done({});
        return;
      }

      // 翻译
      console.log("[YTDual] 开始翻译...");
      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] 翻译完成 " + Object.keys(transMap).length + " 条");

      if (Object.keys(transMap).length > 0) {
        writeCache(cacheKey, transMap);
        // 同时缓存原始 json3 数据（用于合成返回）
        writeCache(cacheKey + "_json3", json3Body);
      }
    }

    // ── 用缓存的 json3 合成双行，返回给 App ──────────────────────────────────
    const json3Body = readCache(cacheKey + "_json3");
    if (!json3Body) {
      console.log("[YTDual] json3 缓存不存在，退出");
      $done({});
      return;
    }

    const result = composeDualJSON3(json3Body, transMap, LAYOUT);
    console.log("[YTDual] ✅ 合成完成，返回 json3");

    // 返回时修改 Content-Type，告诉 App 这是 json3
    $done({
      body: result,
      headers: Object.assign({}, $response.headers || {}, {
        "content-type": "application/json; charset=UTF-8",
        "content-encoding": "identity", // 取消 gzip，直接返回明文
      })
    });

  } catch (e) {
    console.log("[YTDual] 异常: " + e.message);
    $done({});
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 构造 json3 格式 URL（句级字幕，不是逐词的 srv3）
// ══════════════════════════════════════════════════════════════════════════════
function buildJSON3Url(origUrl, params) {
  const strip = new Set([
    "seek_to_segment_start","seg","xorb","xobt","xovt","asr_langs",
    "cbr","cbrver","c","cver","cplayer","cos","cosver","cplatform","cpn"
  ]);
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (strip.has(k)) continue;
    // 替换格式为 json3
    if (k === "fmt" || k === "format") continue;
    parts.push(k + "=" + encodeURIComponent(v));
  }
  parts.push("fmt=json3");
  return "https://www.youtube.com/api/timedtext?" + parts.join("&");
}

// ══════════════════════════════════════════════════════════════════════════════
// 解析 json3，提取句级条目
// ══════════════════════════════════════════════════════════════════════════════
function extractJSON3(body) {
  const entries = [];
  try {
    const data = JSON.parse(body);
    for (const e of (data.events || [])) {
      if (!Array.isArray(e.segs)) continue;
      const text = e.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
      if (text && text !== " ") entries.push({ key: String(e.tStartMs || 0), text });
    }
  } catch (e) { console.log("[YTDual] json3 解析失败: " + e.message); }
  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// 合成双行 json3
// ══════════════════════════════════════════════════════════════════════════════
function composeDualJSON3(body, map, layout) {
  let data;
  try { data = JSON.parse(body); } catch (e) { return body; }

  let hit = 0;
  for (const e of (data.events || [])) {
    if (!Array.isArray(e.segs)) continue;
    const orig = e.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (!orig || orig === " ") continue;
    const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
    if (!trans || trans === orig) continue;
    e.segs = [{ utf8: makeLine(orig, trans, layout) }];
    hit++;
  }
  console.log("[YTDual] JSON3 合成命中 " + hit + " 条");
  return JSON.stringify(data);
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig; // 中文上，英文下
  if (layout === "tl") return trans;
  return orig + "\n" + trans;                       // 英文上，中文下
}

// ══════════════════════════════════════════════════════════════════════════════
// 批量翻译（按字符数分块，保持上下文）
// ══════════════════════════════════════════════════════════════════════════════
const SEP       = "\n❖\n";
const CHUNK_MAX = 3500;

async function translateAll(entries, targetLang) {
  const map = {};
  const chunks = [];
  let cur = [], curLen = 0;

  for (const e of entries) {
    const len = e.text.length + SEP.length;
    if (curLen + len > CHUNK_MAX && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
    cur.push(e); curLen += len;
  }
  if (cur.length) chunks.push(cur);

  console.log("[YTDual] " + chunks.length + " 个翻译批次");

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk    = chunks[ci];
    const combined = chunk.map(e => e.text).join(SEP);
    try {
      const translated = await googleTranslate(combined, targetLang);
      console.log("[YTDual] 批次" + (ci+1) + " 完成，首句: " + translated.slice(0, 40));
      const parts = translated.split(/❖/);
      chunk.forEach((e, i) => {
        const t = (parts[i] || "").trim();
        if (t) map[e.key] = t;
      });
    } catch (e) {
      console.log("[YTDual] 批次" + (ci+1) + " 失败: " + e.message);
    }
  }
  return map;
}

function googleTranslate(text, tl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("超时")), 15000);
    $httpClient.post({
      url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(tl) + "&dt=t&dj=1",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GoogleTranslate/6.29.59279 (iPhone; iOS 15.4; en; iPhone14,2)",
      },
      body: "q=" + encodeURIComponent(text),
    }, (err, resp, respBody) => {
      clearTimeout(timer);
      if (err) { reject(new Error(String(err))); return; }
      try {
        const data = JSON.parse(respBody);
        if (Array.isArray(data.sentences)) {
          resolve(data.sentences.map(s => s.trans || "").join("").trim());
        } else {
          reject(new Error("格式异常: " + respBody.slice(0, 80)));
        }
      } catch (e) { reject(e); }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════════════════════
function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 300) return map[k];
  }
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("超时")), 15000);
    $httpClient.get({
      url,
      headers: { "User-Agent": "com.google.ios.youtube/19.45.4 (iPhone; iOS 17.0)" },
    }, (err, _r, body) => {
      clearTimeout(timer);
      if (err) reject(new Error(String(err)));
      else resolve(body);
    });
  });
}

function parseURLParams(url) {
  const obj = {}, qi = url.indexOf("?");
  if (qi < 0) return obj;
  url.slice(qi+1).split("&").forEach(p => {
    const eq = p.indexOf("=");
    if (eq < 0) return;
    try { obj[decodeURIComponent(p.slice(0,eq))] = decodeURIComponent(p.slice(eq+1)); } catch(_){}
  });
  return obj;
}

function parseArgs(str) {
  const obj = {};
  if (!str) return obj;
  str.split("&").forEach(p => {
    const eq = p.indexOf("=");
    if (eq < 0) return;
    try { obj[decodeURIComponent(p.slice(0,eq))] = decodeURIComponent(p.slice(eq+1)); } catch(_){}
  });
  return obj;
}

function readCache(key) {
  try { const r = $persistentStore.read(key); return r ? JSON.parse(r) : null; } catch(_) { return null; }
}

function writeCache(key, obj) {
  try { $persistentStore.write(JSON.stringify(obj), key); } catch(_) {}
}
