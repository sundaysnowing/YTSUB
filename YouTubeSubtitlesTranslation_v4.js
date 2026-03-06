/*
 * YouTube 双字幕 v4.2
 * 修复：
 *   1. 支持 srv3 格式（YouTube App 主要使用此格式）
 *   2. 处理 gzip 响应（Loon 会自动解压，但需要正确配置）
 *   3. 增加更多日志便于调试
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] 触发 url=" + url.slice(0, 100));
console.log("[YTDual] body长度=" + (body ? body.length : 0));
console.log("[YTDual] body前50=" + (body ? body.slice(0, 50) : "空"));

if (!body || body.length < 10) {
  console.log("[YTDual] body为空退出");
  $done({});
  return;
}

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
const fmt     = params.format || params.fmt || "";

console.log("[YTDual] videoId=" + videoId + " fmt=" + fmt + " targetLang=" + TARGET_LANG);

// 检测响应格式
const bodyFmt = detectFormat(body);
console.log("[YTDual] 响应格式=" + bodyFmt);

if (bodyFmt === "unknown") {
  console.log("[YTDual] 未知格式，body前100: " + body.slice(0, 100));
  $done({});
  return;
}

(async () => {
  try {
    // 提取当前字幕条目
    const entries = extractEntries(body, bodyFmt);
    console.log("[YTDual] 提取到 " + entries.length + " 条字幕");

    if (!entries.length) {
      console.log("[YTDual] 无字幕条目，退出");
      $done({});
      return;
    }

    // 检查缓存
    const cacheKey = "YTDual_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (transMap) {
      console.log("[YTDual] 命中缓存 " + Object.keys(transMap).length + " 条");
    } else {
      // 全量预取
      let allEntries = entries;
      try {
        const fullUrl = buildFullSubUrl(url, params, TARGET_LANG);
        console.log("[YTDual] 预取全量: " + fullUrl.slice(0, 120));
        const fullBody = await httpGet(fullUrl);
        console.log("[YTDual] 全量body长度=" + fullBody.length + " 前50=" + fullBody.slice(0, 50));
        const fullFmt     = detectFormat(fullBody);
        const fullEntries = extractEntries(fullBody, fullFmt);
        console.log("[YTDual] 全量条数=" + fullEntries.length);
        if (fullEntries.length > 0) allEntries = fullEntries;
      } catch (e) {
        console.log("[YTDual] 全量预取失败: " + e.message);
      }

      // 翻译
      console.log("[YTDual] 开始翻译 " + allEntries.length + " 条");
      transMap = await translateAll(allEntries, TARGET_LANG);
      console.log("[YTDual] 翻译完成 " + Object.keys(transMap).length + " 条");

      if (Object.keys(transMap).length > 0 && videoId) {
        writeCache(cacheKey, transMap);
      }
    }

    // 合成
    const result = composeDual(body, bodyFmt, transMap, LAYOUT);
    console.log("[YTDual] 合成完成，返回");
    $done({ body: result });

  } catch (e) {
    console.log("[YTDual] 异常: " + e.message);
    $done({});
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 构造中文全量字幕 URL
// ══════════════════════════════════════════════════════════════════════════════
function buildFullSubUrl(origUrl, params, targetLang) {
  const strip = new Set([
    "seek_to_segment_start","seg","xorb","xobt","xovt","asr_langs",
    "cbr","cbrver","c","cver","cplayer","cos","cosver","cplatform","cpn"
  ]);
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (!strip.has(k)) parts.push(k + "=" + encodeURIComponent(v));
  }
  // 强制 json3（比 srv3 更容易解析）
  const fmtIdx = parts.findIndex(p => p.startsWith("fmt=") || p.startsWith("format="));
  if (fmtIdx < 0) parts.push("fmt=json3");
  else parts[fmtIdx] = "fmt=json3";

  // 加上 tlang 请求中文
  const tlangIdx = parts.findIndex(p => p.startsWith("tlang="));
  const tlang = targetLang === "zh-Hans" ? "zh-Hans"
              : targetLang === "zh-Hant" ? "zh-Hant"
              : targetLang;
  if (tlangIdx < 0) parts.push("tlang=" + encodeURIComponent(tlang));
  else parts[tlangIdx] = "tlang=" + encodeURIComponent(tlang);

  return "https://www.youtube.com/api/timedtext?" + parts.join("&");
}

// ══════════════════════════════════════════════════════════════════════════════
// 格式检测（支持 srv3）
// ══════════════════════════════════════════════════════════════════════════════
function detectFormat(body) {
  const t = (body || "").trimStart();
  if (t.startsWith("{"))      return "json3";   // json3
  if (t.startsWith("WEBVTT")) return "webvtt";  // WebVTT
  if (t.startsWith("<"))      return "xml";     // xml / srv1 / srv2 / srv3
  return "unknown";
}

// ══════════════════════════════════════════════════════════════════════════════
// 提取字幕条目（支持 json3 / xml / srv3）
// ══════════════════════════════════════════════════════════════════════════════
function extractEntries(body, fmt) {
  const entries = [];

  if (fmt === "json3") {
    try {
      const data = JSON.parse(body);
      for (const e of (data.events || [])) {
        if (!Array.isArray(e.segs)) continue;
        const text = e.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
        if (text) entries.push({ key: String(e.tStartMs || 0), text });
      }
    } catch (e) { console.log("[YTDual] JSON解析失败: " + e.message); }

  } else if (fmt === "xml") {
    // srv3 格式：<timedtext><body><p t="1234" d="2000">文本<s>...</s></p></body></timedtext>
    // srv1/srv2 格式：<text start="1.23" dur="2.00">文本</text>

    // 尝试 srv3 的 <p t="..."> 格式
    const pRe = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    let found = false;
    while ((m = pRe.exec(body)) !== null) {
      found = true;
      const ms   = parseInt(m[1]);
      // 去掉内部所有标签（<s>, <br> 等）
      const text = m[2].replace(/<[^>]+>/g, "").replace(/\n/g, " ").trim();
      if (text) entries.push({ key: String(ms), text: decodeHTML(text) });
    }

    // 如果没有 <p t=...>，尝试 srv1/srv2 的 <text start="..."> 格式
    if (!found) {
      const tRe = /<text\b[^>]*\bstart="([^"]*)"[^>]*>([\s\S]*?)<\/text>/gi;
      while ((m = tRe.exec(body)) !== null) {
        const ms   = Math.round(parseFloat(m[1]) * 1000);
        const text = decodeHTML(m[2]).replace(/<[^>]+>/g, "").replace(/\n/g, " ").trim();
        if (text) entries.push({ key: String(ms), text });
      }
    }

  } else if (fmt === "webvtt") {
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("-->")) continue;
      const ms = vttToMs(lines[i].split("-->")[0].trim());
      const textLines = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        textLines.push(lines[j].replace(/<[^>]+>/g, "").trim());
        j++;
      }
      const text = textLines.join(" ").trim();
      if (text) entries.push({ key: String(ms), text });
    }
  }

  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// 合成双行字幕
// ══════════════════════════════════════════════════════════════════════════════
function composeDual(body, fmt, map, layout) {
  if (fmt === "json3") return composeDualJSON3(body, map, layout);
  if (fmt === "xml")   return composeDualXML(body, map, layout);
  if (fmt === "webvtt") return composeDualVTT(body, map, layout);
  return body;
}

function composeDualJSON3(body, map, layout) {
  const data = JSON.parse(body);
  let hit = 0;
  for (const e of (data.events || [])) {
    if (!Array.isArray(e.segs)) continue;
    const orig  = e.segs.map(s => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (!orig) continue;
    const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
    if (!trans || trans === orig) continue;
    e.segs = [{ utf8: makeLine(orig, trans, layout) }];
    hit++;
  }
  console.log("[YTDual] JSON3 命中 " + hit + " 条");
  return JSON.stringify(data);
}

function composeDualXML(body, map, layout) {
  let hit = 0;

  // ── srv3 格式：<p t="毫秒" d="时长"> ────────────────────────────────────────
  // srv3 每个 <p> 只是一个词或短语，需要找到同一句话对应的译文
  // 策略：用 map 里最近的时间戳匹配整句译文，显示在第一个词的位置
  const pMatches = [];
  const pRe = /<p\b([^>]*\bt="(\d+)"[^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(body)) !== null) {
    const ms   = parseInt(m[2]);
    const text = decodeHTML(m[3].replace(/<[^>]+>/g, "").replace(/\n/g, " ").trim());
    if (text) pMatches.push({ full: m[0], attrs: m[1], ms, text, index: m.index });
  }

  if (pMatches.length > 0) {
    // 把相邻的 <p> 按句子分组（间隔超过 1500ms 认为是新句）
    const sentences = [];
    let group = [pMatches[0]];
    for (let i = 1; i < pMatches.length; i++) {
      const gap = pMatches[i].ms - pMatches[i-1].ms;
      if (gap > 1500) {
        sentences.push(group);
        group = [];
      }
      group.push(pMatches[i]);
    }
    sentences.push(group);

    // 为每个句子找译文，写入每个词的 <p> 里（仅第一个 <p> 加译文，其余清空）
    // 实际上更好的方式：把译文加到整句第一个 <p>，后续 <p> 保留原词
    let result = body;
    let offset = 0;

    for (const sentence of sentences) {
      if (!sentence.length) continue;
      const firstMs  = sentence[0].ms;
      const origText = sentence.map(p => p.text).join(" ");
      const trans    = map[String(firstMs)] || fuzzyGet(map, firstMs);
      if (!trans || trans === origText) continue;

      // 只修改这一句里的第一个 <p>：加上双行内容
      const first = sentence[0];
      const newContent = encodeHTML(makeLine(origText, trans, layout));
      const newTag = "<p" + first.attrs + ">" + newContent + "</p>";

      result = result.slice(0, first.index + offset) +
               newTag +
               result.slice(first.index + offset + first.full.length);
      offset += newTag.length - first.full.length;

      // 后续同句 <p> 清空内容（避免重复显示单词）
      for (let i = 1; i < sentence.length; i++) {
        const p = sentence[i];
        const emptyTag = "<p" + p.attrs + "></p>";
        const idx = result.indexOf(p.full, first.index + offset);
        if (idx >= 0) {
          result = result.slice(0, idx) + emptyTag + result.slice(idx + p.full.length);
          offset += emptyTag.length - p.full.length;
        }
      }
      hit++;
    }

    console.log("[YTDual] XML srv3 命中 " + hit + " 句");
    return result;
  }

  // ── srv1/srv2 格式：<text start="秒"> ───────────────────────────────────────
  const result2 = body.replace(/<text\b([^>]*\bstart="([^"]*)"[^>]*)>([\s\S]*?)<\/text>/gi,
    (full, attrs, startSec, content) => {
      const ms   = Math.round(parseFloat(startSec) * 1000);
      const orig = decodeHTML(content).replace(/<[^>]+>/g, "").replace(/\n/g, " ").trim();
      if (!orig) return full;
      const trans = map[String(ms)] || fuzzyGet(map, ms);
      if (!trans || trans === orig) return full;
      hit++;
      return "<text" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</text>";
    }
  );

  console.log("[YTDual] XML srv1/2 命中 " + hit + " 条");
  return result2;
}

function composeDualVTT(body, map, layout) {
  const lines = body.split("\n"), out = [];
  let i = 0, hit = 0;
  while (i < lines.length) {
    out.push(lines[i]);
    if (lines[i].includes("-->")) {
      const ms = vttToMs(lines[i].split("-->")[0].trim());
      const texts = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        texts.push(lines[i].replace(/<[^>]+>/g, "").trim());
        i++;
      }
      const orig  = texts.join(" ").trim();
      const trans = map[String(ms)] || fuzzyGet(map, ms);
      if (trans && trans !== orig) { out.push(makeLine(orig, trans, layout)); hit++; }
      else out.push(orig);
      continue;
    }
    i++;
  }
  console.log("[YTDual] VTT 命中 " + hit + " 条");
  return out.join("\n");
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

// ══════════════════════════════════════════════════════════════════════════════
// 批量翻译
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

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk    = chunks[ci];
    const combined = chunk.map(e => e.text).join(SEP);
    try {
      console.log("[YTDual] 翻译批次 " + (ci+1) + "/" + chunks.length);
      const translated = await googleTranslate(combined, targetLang);
      const parts = translated.split(/❖/);
      chunk.forEach((e, i) => {
        const t = (parts[i] || "").trim();
        if (t) map[e.key] = t;
      });
    } catch (e) {
      console.log("[YTDual] 批次 " + (ci+1) + " 失败: " + e.message);
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
      console.log("[YTDual] 翻译响应状态=" + (resp && resp.status));
      try {
        const data = JSON.parse(respBody);
        if (Array.isArray(data.sentences)) {
          resolve(data.sentences.map(s => s.trans || "").join("").trim());
        } else {
          console.log("[YTDual] 翻译响应异常: " + respBody.slice(0, 100));
          reject(new Error("格式异常"));
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

function vttToMs(s) {
  const p = s.trim().split(":");
  if (p.length === 3) return Math.round((+p[0]*3600 + +p[1]*60 + parseFloat(p[2]))*1000);
  if (p.length === 2) return Math.round((+p[0]*60 + parseFloat(p[1]))*1000);
  return 0;
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

function decodeHTML(s) {
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
}

function encodeHTML(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
