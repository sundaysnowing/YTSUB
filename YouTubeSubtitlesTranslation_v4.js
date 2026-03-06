/*
 * YouTube 双字幕 v4.4
 *
 * 策略：
 *   1. 保持原始 srv3 格式不变（App 要什么格式就还什么格式）
 *   2. 主动抓 json3（句级字幕）用于翻译，不用于返回
 *   3. 把译文按时间戳写回 srv3 的 <p> 节点
 *   4. srv3 每个 <p> 只含一个词，策略是：
 *      - 找到每句第一个 <p>（用 json3 的 tStartMs 对齐）
 *      - 在第一个 <p> 里插入"中文\n英文整句"
 *      - 同句后续 <p> 清空，避免重复
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] 触发 url=" + url.slice(0, 100));
console.log("[YTDual] body前30=" + (body||"").slice(0, 30));

if (!body || body.length < 10) { $done({}); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";

console.log("[YTDual] videoId=" + videoId + " lang=" + TARGET_LANG);
if (!videoId) { $done({}); return; }

const bodyFmt = detectFormat(body);
console.log("[YTDual] 响应格式=" + bodyFmt);
if (bodyFmt === "unknown") { $done({}); return; }

(async () => {
  try {
    const cacheKey     = "YTDual_" + videoId + "_" + TARGET_LANG;
    const cacheKeyOrig = "YTDual_" + videoId + "_orig";
    let transMap = readCache(cacheKey);

    if (transMap) {
      console.log("[YTDual] 命中缓存 " + Object.keys(transMap).length + " 条");
    } else {
      // ── 抓 json3 句级字幕来翻译 ─────────────────────────────────────────────
      const json3Url = buildJSON3Url(url, params);
      console.log("[YTDual] 抓 json3: " + json3Url.slice(0, 120));
      let json3Body;
      try {
        json3Body = await httpGet(json3Url);
        console.log("[YTDual] json3 长度=" + json3Body.length);
      } catch(e) {
        console.log("[YTDual] json3 失败: " + e.message + "，降级用 body");
        json3Body = null;
      }

      // 解析句级字幕
      let entries = json3Body ? extractJSON3(json3Body) : [];
      console.log("[YTDual] 句级字幕 " + entries.length + " 条");

      // 如果 json3 拿不到，从当前 body 提取
      if (!entries.length) {
        entries = extractEntries(body, bodyFmt);
        console.log("[YTDual] 降级提取 " + entries.length + " 条");
      }

      if (!entries.length) { $done({}); return; }

      // 翻译
      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] 翻译完成 " + Object.keys(transMap).length + " 条");
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    }

    // ── 把译文写回原始格式 ───────────────────────────────────────────────────
    const result = composeDual(body, bodyFmt, transMap, LAYOUT);
    console.log("[YTDual] ✅ 返回原格式");
    $done({ body: result });

  } catch(e) {
    console.log("[YTDual] 异常: " + e.message);
    $done({}); // 出错时原样放行，不破坏字幕显示
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 构造 json3 URL（用于获取句级字幕来翻译）
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

// ══════════════════════════════════════════════════════════════════════════════
// 解析 json3 → 句级条目
// ══════════════════════════════════════════════════════════════════════════════
function extractJSON3(body) {
  const entries = [];
  try {
    const data = JSON.parse(body);
    for (const e of (data.events || [])) {
      if (!Array.isArray(e.segs)) continue;
      const text = e.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
      if (text) entries.push({ key: String(e.tStartMs || 0), text });
    }
  } catch(e) { console.log("[YTDual] json3 解析失败: " + e.message); }
  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// 从任意格式提取条目（降级用）
// ══════════════════════════════════════════════════════════════════════════════
function extractEntries(body, fmt) {
  if (fmt === "json3") return extractJSON3(body);
  const entries = [];
  if (fmt === "xml") {
    // srv3 <p t="ms">
    const re = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const text = decodeHTML(m[2].replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
      if (text) entries.push({ key: m[1], text });
    }
    // srv1 <text start="s">
    if (!entries.length) {
      const re2 = /<text\b[^>]*\bstart="([^"]*)"[^>]*>([\s\S]*?)<\/text>/gi;
      while ((m = re2.exec(body)) !== null) {
        const ms = Math.round(parseFloat(m[1]) * 1000);
        const text = decodeHTML(m[2].replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(ms), text });
      }
    }
  }
  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// 合成双行（保持原格式）
// ══════════════════════════════════════════════════════════════════════════════
function composeDual(body, fmt, map, layout) {
  if (fmt === "json3") return composeDualJSON3(body, map, layout);
  if (fmt === "xml")   return composeDualSRV3(body, map, layout);
  return body;
}

function composeDualJSON3(body, map, layout) {
  let data;
  try { data = JSON.parse(body); } catch(e) { return body; }
  let hit = 0;
  for (const e of (data.events || [])) {
    if (!Array.isArray(e.segs)) continue;
    const orig = e.segs.map(s => s.utf8 || "").join("").replace(/\n/g," ").trim();
    if (!orig) continue;
    const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
    if (!trans || trans === orig) continue;
    e.segs = [{ utf8: makeLine(orig, trans, layout) }];
    hit++;
  }
  console.log("[YTDual] json3 命中 " + hit);
  return JSON.stringify(data);
}

function composeDualSRV3(body, map, layout) {
  // srv3 每个 <p t="ms"> 只有一个词
  // 策略：找到 map 里每句的起始时间戳，定位到 srv3 里最近的 <p>，
  //       把整句译文插入那个 <p>，同句其他词保持不动（App 自行渲染）
  // 
  // 更简单有效的方式：直接在每个 <p> 里查找对应译文
  // 因为 json3 和 srv3 时间戳是一致的，精确 or 模糊匹配

  let hit = 0;
  // 收集所有 <p> 节点和它们的时间戳
  const pList = [];
  const pRe   = /<p\b([^>]*\bt="(\d+)"[^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(body)) !== null) {
    pList.push({ full: m[0], attrs: m[1], ms: parseInt(m[2]), content: m[3], index: m.index });
  }

  if (!pList.length) {
    // srv1/srv2 fallback
    return body.replace(/<text\b([^>]*\bstart="([^"]*)"[^>]*)>([\s\S]*?)<\/text>/gi,
      (full, attrs, startSec, content) => {
        const ms   = Math.round(parseFloat(startSec) * 1000);
        const orig = decodeHTML(content.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
        if (!orig) return full;
        const trans = map[String(ms)] || fuzzyGet(map, ms);
        if (!trans || trans === orig) return full;
        hit++;
        return "<text" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</text>";
      }
    );
  }

  // 对每个 <p>，检查 map 里是否有以此时间戳开头的句子译文
  // 如果有，把整句原文+译文写入此 <p>，并把这一句的后续 <p> 清空
  let result   = body;
  let offset   = 0;
  // 标记已处理过的 <p> 索引（避免重复清空）
  const processed = new Set();

  // 为 map 的每个 key 找对应的 pList 索引
  const mapKeys = Object.keys(map).map(Number).sort((a,b)=>a-b);

  for (const sentenceMs of mapKeys) {
    // 找 pList 里时间戳最近的 <p>（±500ms）
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 0; i < pList.length; i++) {
      if (processed.has(i)) continue;
      const diff = Math.abs(pList[i].ms - sentenceMs);
      if (diff < bestDiff && diff <= 500) { bestDiff = diff; bestIdx = i; }
    }
    if (bestIdx < 0) continue;

    const p     = pList[bestIdx];
    const orig  = decodeHTML(p.content.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
    const trans = map[String(sentenceMs)];
    if (!trans) continue;

    // 找出这一句对应的所有后续 <p>（到下一个 map key 之间的 pList 项）
    const nextSentenceMs = mapKeys[mapKeys.indexOf(sentenceMs) + 1] || Infinity;
    const sentenceParts  = [];
    for (let i = bestIdx; i < pList.length; i++) {
      if (pList[i].ms >= nextSentenceMs) break;
      sentenceParts.push(i);
    }

    // 提取完整英文句子（把这句所有 <p> 的文字合并）
    const fullOrig = sentenceParts
      .map(i => decodeHTML(pList[i].content.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim())
      .filter(Boolean).join(" ");

    // 修改第一个 <p>：写入双行
    const newFirst = "<p" + p.attrs + ">" + encodeHTML(makeLine(fullOrig || orig, trans, layout)) + "</p>";
    const realIdx  = result.indexOf(p.full, p.index + offset - 200 < 0 ? 0 : p.index + offset - 200);
    if (realIdx >= 0) {
      result  = result.slice(0, realIdx) + newFirst + result.slice(realIdx + p.full.length);
      offset += newFirst.length - p.full.length;
      hit++;
    }

    // 清空同句后续 <p>（只保留时间戳属性）
    for (let k = 1; k < sentenceParts.length; k++) {
      const pi      = pList[sentenceParts[k]];
      const emptyP  = "<p" + pi.attrs + "></p>";
      const ri      = result.indexOf(pi.full, pi.index + offset - 500 < 0 ? 0 : pi.index + offset - 500);
      if (ri >= 0) {
        result  = result.slice(0, ri) + emptyP + result.slice(ri + pi.full.length);
        offset += emptyP.length - pi.full.length;
      }
      processed.add(sentenceParts[k]);
    }
    processed.add(bestIdx);
  }

  console.log("[YTDual] srv3 命中 " + hit + " 句");
  return result;
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
  console.log("[YTDual] " + chunks.length + " 批");
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    try {
      const translated = await googleTranslate(chunk.map(e=>e.text).join(SEP), tl);
      translated.split(/❖/).forEach((t, i) => {
        const clean = t.trim();
        if (clean && chunk[i]) map[chunk[i].key] = clean;
      });
    } catch(e) { console.log("[YTDual] 批次" + (ci+1) + "失败: " + e.message); }
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
    }, (err, _r, rb) => {
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

function decodeHTML(s) {
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
}

function encodeHTML(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
