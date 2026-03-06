/*
 * YouTube 双字幕 v5.6
 *
 * 不改请求格式（App 只认 srv3）
 * 响应阶段：
 *   1. 收到 srv3，去掉 <s> 标签得到每个 <p> 的纯文本
 *   2. 额外抓一份 fmt=vtt（完整句子），作为翻译源
 *   3. 翻译 VTT 的完整句子
 *   4. 把译文按时间戳对应写回 srv3 的每个 <p>
 *
 * 效果：App 显示 srv3（不报错），但译文来自完整句子翻译（断句准确）
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;
const url  = $request.url;
let   body = $response.body;

function safeReturn(b) { $done({ body: b || body }); }

if (!body || body.length < 10) { safeReturn(body); return; }

const fmt = detectFormat(body);
if (fmt !== "xml") { safeReturn(body); return; }  // 只处理 srv3/xml

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { safeReturn(body); return; }

// 去掉 <s> 标签
body = body.replace(/<\/?s\b[^>]*>/g, "");

(async () => {
  try {
    const cacheKey = "YTDual56_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      // 抓 VTT 格式（完整句子）
      const vttUrl = url.replace(/([?&])(fmt|format)=([^&]*)/g, "$1fmt=vtt");
      console.log("[YTDual] 抓 vtt: " + vttUrl.slice(0, 100));

      let vttBody = "";
      try {
        vttBody = await httpGet(vttUrl);
        console.log("[YTDual] vtt len=" + vttBody.length + " head=" + vttBody.slice(0, 10));
      } catch(e) {
        console.log("[YTDual] vtt 失败: " + e.message);
      }

      let entries = [];

      if (vttBody && vttBody.includes("WEBVTT")) {
        // 用 VTT 完整句子翻译
        entries = extractVTT(vttBody);
        console.log("[YTDual] vtt entries=" + entries.length);
      }

      if (!entries.length) {
        // 降级：用 srv3 的 <p> 内容翻译
        entries = extractSRV3(body);
        console.log("[YTDual] srv3 entries=" + entries.length);
      }

      if (!entries.length) { safeReturn(body); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] translated=" + Object.keys(transMap).length);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    } else {
      console.log("[YTDual] cache=" + Object.keys(transMap).length);
    }

    const result = composeSRV3(body, transMap, LAYOUT);
    safeReturn(result);

  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    safeReturn(body);
  }
})();

// ── 从 VTT 提取完整句子 ───────────────────────────────────────────────────────
function extractVTT(vtt) {
  const entries = [];
  const blocks  = vtt.split(/\n\n+/);
  for (const block of blocks) {
    const lines   = block.trim().split("\n");
    const timeIdx = lines.findIndex(l => l.includes("-->"));
    if (timeIdx < 0) continue;
    const timeLine = lines[timeIdx].trim();
    // 把 VTT 时间戳转成毫秒作为 key
    const ms = vttTimeToMs(timeLine.split("-->")[0].trim());
    if (ms < 0) continue;
    const text = lines.slice(timeIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) entries.push({ key: String(ms), text });
  }
  return entries;
}

function vttTimeToMs(t) {
  // 支持 HH:MM:SS.mmm 和 MM:SS.mmm
  const parts = t.split(":");
  try {
    if (parts.length === 3) {
      return (parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseFloat(parts[2])) * 1000 | 0;
    } else if (parts.length === 2) {
      return (parseInt(parts[0])*60 + parseFloat(parts[1])) * 1000 | 0;
    }
  } catch(e) {}
  return -1;
}

// ── 从 srv3 提取 <p> 文本（降级用）────────────────────────────────────────────
function extractSRV3(body) {
  const entries = [];
  body.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (_, attrs, content) => {
    if (/\ba=["']?1["']?/.test(attrs)) return;
    const tM = attrs.match(/\bt="(\d+)"/);
    if (!tM) return;
    const text = decodeHTML(content).replace(/\s+/g," ").trim();
    if (text) entries.push({ key: tM[1], text });
  });
  return entries;
}

// ── 把译文写回 srv3 ───────────────────────────────────────────────────────────
function composeSRV3(body, map, layout) {
  let hit = 0;
  const result = body.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (full, attrs, content) => {
    if (/\ba=["']?1["']?/.test(attrs)) return full;
    const tM = attrs.match(/\bt="(\d+)"/);
    if (!tM) return full;
    const orig = decodeHTML(content).replace(/\s+/g," ").trim();
    if (!orig) return full;
    const trans = map[tM[1]] || fuzzyGet(map, parseInt(tM[1]));
    if (!trans) return full;
    hit++;
    return "<p" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</p>";
  });
  console.log("[YTDual] srv3 hit=" + hit);
  return result;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

// ── 翻译 ──────────────────────────────────────────────────────────────────────
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
    } catch(e) { console.log("[YTDual] batch fail: " + e.message); }
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

// ── 工具 ──────────────────────────────────────────────────────────────────────
function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{"))    return "json3";
  if (t.startsWith("WEB"))  return "vtt";
  if (t.startsWith("<"))    return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  let best = null, bestDiff = 600;
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
