/*
 * YouTube 双字幕 v5.7
 *
 * 显示格式：
 *   中文译文（一行）
 *   完整英文原句（App 自动换行，可能两行）
 *
 * 实现：
 *   每两个相邻有内容的 <p> 合并成一句
 *   第一个 <p> 写 "中文\n完整英文"，时长延长覆盖整句
 *   第二个 <p> 清空（时长保留，撑住时间轴）
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

// 剥离 <s> 子标签
if (fmt === "xml") body = body.replace(/<\/?s\b[^>]*>/g, "");

(async () => {
  try {
    const cacheKey = "YTDual57_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      const entries = extractEntries(body, fmt);
      console.log("[YTDual] entries=" + entries.length);
      if (!entries.length) { safeReturn(body); return; }
      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] translated=" + Object.keys(transMap).length);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    } else {
      console.log("[YTDual] cache=" + Object.keys(transMap).length);
    }

    safeReturn(composeDual(body, fmt, transMap, LAYOUT));
  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    safeReturn(body);
  }
})();

// ── 提取字幕条目 ──────────────────────────────────────────────────────────────
// xml：每两个 <p> 合并成一句，key = 第一个 <p> 的时间戳
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
    const pList = parseSRV3(body);
    for (let i = 0; i < pList.length; i += 2) {
      const a = pList[i], b = pList[i+1];
      const text = b ? (a.text + " " + b.text).trim() : a.text;
      entries.push({ key: String(a.ms), text });
    }
  }
  return entries;
}

// ── 解析 srv3 有内容的 <p> 列表 ───────────────────────────────────────────────
function parseSRV3(body) {
  const list = [];
  body.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (full, attrs, content, offset) => {
    if (/\ba=["']?1["']?/.test(attrs)) return;
    const tM = attrs.match(/\bt="(\d+)"/);
    const dM = attrs.match(/\bd="(\d+)"/);
    if (!tM) return;
    const text = decodeHTML(content).replace(/\s+/g," ").trim();
    if (!text) return;
    list.push({ ms: +tM[1], dur: +(dM?.[1]||2000), text, full, attrs, offset });
  });
  return list;
}

// ── 合成双行 ──────────────────────────────────────────────────────────────────
function composeDual(body, fmt, map, layout) {
  try {
    if (fmt === "json3") {
      const data = JSON.parse(body);
      for (const e of (data.events||[])) {
        if (!e.segs) continue;
        const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (!orig) continue;
        const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
        if (trans && trans !== orig) e.segs = [{ utf8: makeLine(orig, trans, layout) }];
      }
      return JSON.stringify(data);
    }

    if (fmt === "xml") {
      const pList = parseSRV3(body);
      if (!pList.length) { safeReturn(body); return body; }

      // 建立替换表：full -> newContent
      const replacements = new Map();

      for (let i = 0; i < pList.length; i += 2) {
        const first  = pList[i];
        const second = pList[i+1];

        const fullOrig = second ? (first.text + " " + second.text).trim() : first.text;
        const trans    = map[String(first.ms)] || fuzzyGet(map, first.ms);
        if (!trans) continue;

        // 第一个 <p>：延长时长覆盖整句，写 中文\n英文
        const totalEnd = second ? (second.ms + second.dur) : (first.ms + first.dur);
        const totalDur = totalEnd - first.ms;
        const newAttrs = first.attrs.replace(/\bd="[^"]*"/, 'd="' + totalDur + '"');
        const content  = encodeHTML(makeLine(fullOrig, trans, layout));
        replacements.set(first.full, "<p" + newAttrs + ">" + content + "</p>");

        // 第二个 <p>：清空内容，保留标签（时间轴占位）
        if (second) {
          replacements.set(second.full, "<p" + second.attrs + "></p>");
        }
      }

      // 一次性替换
      let result = body;
      for (const [oldTag, newTag] of replacements) {
        result = result.replace(oldTag, newTag);
      }

      console.log("[YTDual] pairs=" + (pList.length >> 1));
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
      t.split(/❖/).forEach((s,i) => { if (chunk[i]) map[chunk[i].key] = s.trim(); });
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
      try { const d = JSON.parse(rb); resolve(d.sentences.map(s=>s.trans||"").join("")); }
      catch(e) { reject(e); }
    });
  });
}

// ── 工具 ──────────────────────────────────────────────────────────────────────
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
