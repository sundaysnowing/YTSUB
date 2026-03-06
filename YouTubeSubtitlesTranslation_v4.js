/*
 * YouTube 双字幕 v5.3 - 借鉴 DualSubs 方案
 *
 * 核心改动（来自 Neurogram DualSubs）：
 *   1. 先去掉 srv3 里所有 <s> 子标签，只留 <p> 节点
 *   2. 用 tlang 请求 YouTube 官方翻译（而不是 Google Translate）
 *   3. 用正则直接 replace <p>内容</p>，不用 indexOf 偏移计算
 *
 * 如果视频没有 YouTube 官方翻译，降级用 Google Translate
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;
const url  = $request.url;
let   body = $response.body;

function safeReturn(b) { $done({ body: b || body }); }

if (!body || body.length < 10) { safeReturn(body); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { safeReturn(body); return; }

const fmt = detectFormat(body);
if (fmt === "unknown") { safeReturn(body); return; }

// ASR 自动字幕：先剥离所有 <s> 标签，让每个 <p> 包含完整文本
const isASR = url.includes("&kind=asr") || url.includes("caps=asr");
if (fmt === "xml" && isASR) {
  body = body.replace(/<\/?s[^>]*>/g, "");
}

(async () => {
  try {
    const cacheKey = "YTDual53_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      transMap = {};

      // 方案1：用 tlang 请求 YouTube 官方翻译
      const tlangUrl = buildTlangUrl(url, TARGET_LANG);
      console.log("[YTDual] 请求 tlang: " + tlangUrl.slice(0, 100));
      try {
        const tlangBody = await httpGet(tlangUrl);
        // 同样剥离 <s> 标签
        const cleanTlang = isASR ? tlangBody.replace(/<\/?s[^>]*>/g, "") : tlangBody;
        transMap = buildTransMapFromTlang(body, cleanTlang, fmt);
        console.log("[YTDual] tlang 命中=" + Object.keys(transMap).length);
      } catch(e) {
        console.log("[YTDual] tlang 失败: " + e.message);
      }

      // 方案2：如果 tlang 没有内容，降级用 Google Translate
      if (Object.keys(transMap).length === 0) {
        console.log("[YTDual] 降级 Google Translate");
        const entries = extractEntries(body, fmt);
        console.log("[YTDual] entries=" + entries.length);
        if (entries.length) {
          transMap = await translateAll(entries, TARGET_LANG);
          console.log("[YTDual] Google 翻译=" + Object.keys(transMap).length);
        }
      }

      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    } else {
      console.log("[YTDual] 缓存=" + Object.keys(transMap).length);
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    safeReturn(result);

  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    safeReturn(body);
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 构造 tlang URL
// ══════════════════════════════════════════════════════════════════════════════
function buildTlangUrl(url, tl) {
  const tlang = tl === "zh-Hans" ? "zh-Hans" : tl === "zh-Hant" ? "zh-Hant" : tl;
  // 去掉已有的 tlang，加上新的
  return url.replace(/&tlang=[^&]*/g, "") + "&tlang=" + encodeURIComponent(tlang);
}

// ══════════════════════════════════════════════════════════════════════════════
// 从 tlang 响应构建翻译 map（以 <p> 时间戳为 key）
// ══════════════════════════════════════════════════════════════════════════════
function buildTransMapFromTlang(origBody, tlangBody, fmt) {
  const map = {};
  if (fmt === "json3") {
    try {
      const orig  = JSON.parse(origBody);
      const trans = JSON.parse(tlangBody);
      const tMap  = {};
      for (const e of (trans.events||[])) {
        if (!e.segs) continue;
        const t = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (t) tMap[String(e.tStartMs||0)] = t;
      }
      for (const e of (orig.events||[])) {
        if (!e.segs) continue;
        const t = tMap[String(e.tStartMs)] || fuzzyGet(tMap, e.tStartMs);
        if (t) map[String(e.tStartMs||0)] = t;
      }
    } catch(e) {}
  } else if (fmt === "xml") {
    // 从 tlang body 提取 <p t="...">文本</p> 映射
    const re = /<p\b([^>]*)>([^<]*)<\/p>/gi;
    let m;
    while ((m = re.exec(tlangBody)) !== null) {
      const tM = m[1].match(/\bt="(\d+)"/);
      if (!tM) continue;
      const text = decodeHTML(m[2]).replace(/\s+/g," ").trim();
      if (text) map[tM[1]] = text;
    }
  }
  return map;
}

// ══════════════════════════════════════════════════════════════════════════════
// 提取字幕条目（用于 Google Translate 降级）
// ══════════════════════════════════════════════════════════════════════════════
function extractEntries(body, fmt) {
  const entries = [];
  if (fmt === "json3") {
    try {
      const data = JSON.parse(body);
      for (const e of (data.events||[])) {
        if (!e.segs) continue;
        const text = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(e.tStartMs||0), text });
      }
    } catch(e) {}
  } else if (fmt === "xml") {
    const re = /<p\b([^>]*)>([^<]*)<\/p>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (/\ba=["']?1["']?/.test(m[1])) continue;
      const tM = m[1].match(/\bt="(\d+)"/);
      if (!tM) continue;
      const text = decodeHTML(m[2]).replace(/\s+/g," ").trim();
      if (text) entries.push({ key: tM[1], text });
    }
  }
  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// 合成双行（借鉴 DualSubs 的正则 replace 方式）
// ══════════════════════════════════════════════════════════════════════════════
function composeDual(body, fmt, map, layout) {
  try {
    if (fmt === "json3") {
      const data = JSON.parse(body);
      for (const e of (data.events||[])) {
        if (!e.segs) continue;
        const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (!orig) continue;
        const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
        if (trans && trans !== orig) {
          e.segs = [{ utf8: makeLine(orig, trans, layout) }];
        }
      }
      return JSON.stringify(data);
    }

    if (fmt === "xml") {
      // 用 DualSubs 的方式：正则匹配 <p t="..." d="...">内容</p> 直接替换
      // 剥离 <s> 后，每个 <p> 的内容是纯文本
      const timeline = body.match(/<p t="\d+" d="\d+"[^>]*>/g) || [];
      let result = body;
      let hit = 0;

      for (const tag of timeline) {
        const patt = new RegExp(escapeRegex(tag) + "([^<]*)<\\/p>");
        const origMatch = result.match(patt);
        if (!origMatch) continue;

        const origText = decodeHTML(origMatch[1]).replace(/\s+/g," ").trim();
        if (!origText) continue;

        const tM = tag.match(/\bt="(\d+)"/);
        if (!tM) continue;
        const trans = map[tM[1]] || fuzzyGet(map, parseInt(tM[1]));
        if (!trans) continue;

        if (layout === "f") {
          result = result.replace(patt, `${tag}${encodeHTML(trans)}\n${encodeHTML(origText)}</p>`);
        } else if (layout === "tl") {
          result = result.replace(patt, `${tag}${encodeHTML(trans)}</p>`);
        } else {
          result = result.replace(patt, `${tag}${encodeHTML(origText)}\n${encodeHTML(trans)}</p>`);
        }
        hit++;
      }

      console.log("[YTDual] xml hit=" + hit);
      return result;
    }
  } catch(e) { console.log("[YTDual] compose ERR: " + e.message); }
  return body;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ══════════════════════════════════════════════════════════════════════════════
// 翻译（Google Translate 降级用）
// ══════════════════════════════════════════════════════════════════════════════
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
  for (const chunk of chunks) {
    try {
      const t = await googleTranslate(chunk.map(e=>e.text).join(SEP), tl);
      t.split(/❖/).forEach((s,i) => {
        if (chunk[i]) map[chunk[i].key] = s.trim();
      });
    } catch(e) { console.log("[YTDual] GT fail: " + e.message); }
  }
  return map;
}

function googleTranslate(text, tl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    $httpClient.post({
      url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(tl) + "&dt=t&dj=1",
      headers: { "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"GoogleTranslate/6.29.59279 (iPhone; iOS 15.4; en; iPhone14,2)" },
      body: "q=" + encodeURIComponent(text),
    }, (err,_r,rb) => {
      clearTimeout(timer);
      if (err) return reject(new Error(String(err)));
      try {
        const d = JSON.parse(rb);
        resolve(d.sentences.map(s=>s.trans||"").join(""));
      } catch(e) { reject(e); }
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    $httpClient.get({ url, headers:{"User-Agent":"com.google.ios.youtube/19.45.4 (iPhone; iOS 17.0)"} },
      (err,_r,b) => { clearTimeout(timer); if(err) reject(new Error(String(err))); else resolve(b); });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════════════════════════
function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{")) return "json3";
  if (t.startsWith("<")) return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 300) return map[k];
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

function readCache(k) { try{return JSON.parse($persistentStore.read(k))}catch(e){return null} }
function writeCache(k,v) { try{$persistentStore.write(JSON.stringify(v),k)}catch(e){} }

function decodeHTML(s) {
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c));
}
function encodeHTML(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
