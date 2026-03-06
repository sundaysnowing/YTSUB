/*
 * YouTube 双字幕 v4.1 - 调试修复版
 * 修复：
 *   1. $request 在 http-response 脚本中访问方式修正
 *   2. 全文预取逻辑简化，增加详细日志
 *   3. Google Translate 接口更稳定
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] ✅ 脚本触发, url=" + url.slice(0, 80));

if (!body || body.length < 20) {
  console.log("[YTDual] ❌ body 为空，退出");
  $done({});
  return;
}

if (!url.includes("youtube.com/api/timedtext")) {
  console.log("[YTDual] ❌ 不是字幕接口，退出");
  $done({});
  return;
}

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "s";

console.log("[YTDual] targetLang=" + TARGET_LANG + " layout=" + LAYOUT);

const fmt = detectFormat(body);
console.log("[YTDual] 字幕格式=" + fmt + " body长度=" + body.length);

if (fmt === "unknown") {
  console.log("[YTDual] ❌ 未知格式，body前100: " + body.slice(0, 100));
  $done({});
  return;
}

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
console.log("[YTDual] videoId=" + videoId);

(async () => {
  try {
    const entries = extractEntries(body, fmt);
    console.log("[YTDual] 当前批次字幕条数=" + entries.length);

    if (!entries.length) {
      console.log("[YTDual] ❌ 未提取到字幕条目，body前200: " + body.slice(0, 200));
      $done({});
      return;
    }

    const cacheKey = "YTDual_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (transMap) {
      console.log("[YTDual] ✅ 命中缓存，条数=" + Object.keys(transMap).length);
    } else {
      let allEntries = entries;
      try {
        const fullUrl  = buildFullSubUrl(url, params);
        console.log("[YTDual] 请求全量字幕: " + fullUrl.slice(0, 120));
        const fullBody = await httpGet(fullUrl);
        const fullFmt  = detectFormat(fullBody);
        console.log("[YTDual] 全量字幕格式=" + fullFmt + " 长度=" + fullBody.length);
        const fullEntries = extractEntries(fullBody, fullFmt);
        console.log("[YTDual] 全量字幕条数=" + fullEntries.length);
        if (fullEntries.length > entries.length) allEntries = fullEntries;
      } catch (e) {
        console.log("[YTDual] ⚠️ 全量预取失败: " + e.message);
      }

      console.log("[YTDual] 开始翻译 " + allEntries.length + " 条...");
      transMap = await translateAll(allEntries, TARGET_LANG);
      console.log("[YTDual] 翻译完成，得到 " + Object.keys(transMap).length + " 条译文");

      if (Object.keys(transMap).length > 0 && videoId) {
        writeCache(cacheKey, transMap);
      }
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    console.log("[YTDual] ✅ 完成，返回");
    $done({ body: result });

  } catch (e) {
    console.log("[YTDual] ❌ 异常: " + e.message);
    $done({});
  }
})();

function buildFullSubUrl(origUrl, params) {
  const strip = new Set(["seek_to_segment_start","seg","xorb","xobt","xovt","asr_langs","cbr","cbrver","c","cver","cplayer","cos","cosver","cplatform","cpn"]);
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (!strip.has(k)) parts.push(k + "=" + encodeURIComponent(v));
  }
  const idx = parts.findIndex(p => p.startsWith("fmt="));
  if (idx < 0) parts.push("fmt=json3");
  else parts[idx] = "fmt=json3";
  return "https://www.youtube.com/api/timedtext?" + parts.join("&");
}

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
  } else if (fmt === "xml") {
    const re = /<text\b[^>]*\bstart="([^"]*)"[^>]*>([\s\S]*?)<\/text>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const ms   = Math.round(parseFloat(m[1]) * 1000);
      const text = decodeHTML(m[2]).replace(/\n/g, " ").trim();
      if (text) entries.push({ key: String(ms), text });
    }
  }
  return entries;
}

const SEP = "\n❖\n";
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
      console.log("[YTDual] 批次" + (ci+1) + " 字符数=" + combined.length);
      const translated = await googleTranslate(combined, targetLang);
      console.log("[YTDual] 批次" + (ci+1) + " 结果前50: " + translated.slice(0, 50));
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
    const timer = setTimeout(() => reject(new Error("翻译超时")), 15000);
    $httpClient.post({
      url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(tl) + "&dt=t&dj=1",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GoogleTranslate/6.29.59279 (iPhone; iOS 15.4; en; iPhone14,2)",
      },
      body: "q=" + encodeURIComponent(text),
    }, (err, resp, respBody) => {
      clearTimeout(timer);
      if (err) { console.log("[YTDual] 请求错误: " + JSON.stringify(err)); reject(new Error(String(err))); return; }
      console.log("[YTDual] 翻译响应状态=" + (resp && resp.status));
      try {
        const data = JSON.parse(respBody);
        if (Array.isArray(data.sentences)) {
          resolve(data.sentences.map(s => s.trans || "").join("").trim());
        } else {
          console.log("[YTDual] 响应异常: " + respBody.slice(0, 100));
          reject(new Error("响应格式异常"));
        }
      } catch (e) {
        console.log("[YTDual] 解析失败: " + respBody.slice(0, 100));
        reject(e);
      }
    });
  });
}

function composeDual(body, fmt, map, layout) {
  if (fmt === "json3")  return composeDualJSON3(body, map, layout);
  if (fmt === "webvtt") return composeDualVTT(body, map, layout);
  if (fmt === "xml")    return composeDualXML(body, map, layout);
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

function composeDualXML(body, map, layout) {
  let hit = 0;
  const result = body.replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, (full, attrs, content) => {
    const sm = attrs.match(/\bstart="([^"]*)"/);
    if (!sm) return full;
    const ms    = Math.round(parseFloat(sm[1]) * 1000);
    const orig  = decodeHTML(content).replace(/\n/g, " ").trim();
    const trans = map[String(ms)] || fuzzyGet(map, ms);
    if (!trans || trans === orig) return full;
    hit++;
    return "<text" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</text>";
  });
  console.log("[YTDual] XML 命中 " + hit + " 条");
  return result;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

function detectFormat(body) {
  const t = (body || "").trimStart();
  if (t.startsWith("{"))      return "json3";
  if (t.startsWith("WEBVTT")) return "webvtt";
  if (t.startsWith("<"))      return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 300) return map[k];
  }
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("请求超时")), 15000);
    $httpClient.get({ url, headers: { "User-Agent": "com.google.ios.youtube/19.45.4 (iPhone; iOS 17.0)" } },
      (err, _r, body) => { clearTimeout(timer); if (err) reject(new Error(String(err))); else resolve(body); });
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
