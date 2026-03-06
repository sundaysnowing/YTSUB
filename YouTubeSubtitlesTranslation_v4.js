/*
 * YouTube 双字幕 v5.5
 *
 * 核心方案：请求阶段把 fmt=srv3 改成 fmt=vtt
 * VTT 格式每条是完整句子，和沉浸式翻译效果一样，彻底解决三行问题
 *
 * 请求阶段：改 fmt=vtt，同时记录 content-type 需要改
 * 响应阶段：处理 WebVTT，翻译，在每句下方插入中文译文
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;

// ── 判断阶段 ──────────────────────────────────────────────────────────────────
if (typeof $response === "undefined") {
  // 请求阶段
  const url = $request.url;
  if (!url.includes("/api/timedtext")) { $done({}); return; }

  let newUrl = url.replace(/([?&])(fmt|format)=([^&]*)/g, "$1fmt=vtt");
  if (!/[?&]fmt=/.test(newUrl)) newUrl += "&fmt=vtt";

  console.log("[YTDual] REQ 改为 fmt=vtt");
  $done({ url: newUrl });
  return;
}

// 响应阶段
const url  = $request.url;
let   body = $response.body;

console.log("[YTDual] RESP len=" + (body||"").length + " head=" + (body||"").slice(0,20));

function safeReturn(b) {
  // 修正响应头
  const h = {};
  for (const k of Object.keys($response.headers || {})) {
    const kl = k.toLowerCase();
    if (kl === "content-encoding" || kl === "content-length") continue;
    h[k] = $response.headers[k];
  }
  h["content-type"] = "text/vtt; charset=UTF-8";
  $done({ body: b || body, headers: h });
}

if (!body || body.length < 10) { $done({}); return; }
if (!body.includes("WEBVTT")) { $done({}); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { $done({}); return; }

(async () => {
  try {
    const cacheKey = "YTDual55_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      const entries = extractVTT(body);
      console.log("[YTDual] vtt entries=" + entries.length);
      if (!entries.length) { $done({}); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] translated=" + Object.keys(transMap).length);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    } else {
      console.log("[YTDual] cache=" + Object.keys(transMap).length);
    }

    const result = composeVTT(body, transMap, LAYOUT);
    safeReturn(result);

  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    $done({});
  }
})();

// ── 解析 WebVTT ───────────────────────────────────────────────────────────────
// VTT 格式：
// 00:00:00.080 --> 00:00:03.760
// All right, Burger King has a beef with McDonald's.
function extractVTT(body) {
  const entries = [];
  const blocks  = body.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    // 找时间行
    const timeIdx = lines.findIndex(l => l.includes("-->"));
    if (timeIdx < 0) continue;
    const timeLine = lines[timeIdx];
    const textLines = lines.slice(timeIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!textLines) continue;
    entries.push({ key: timeLine.trim(), text: textLines });
  }
  return entries;
}

// ── 合成双行 VTT ──────────────────────────────────────────────────────────────
function composeVTT(body, map, layout) {
  const blocks  = body.split(/\n\n+/);
  const result  = [];
  let   hit     = 0;

  for (const block of blocks) {
    const lines   = block.trim().split("\n");
    const timeIdx = lines.findIndex(l => l.includes("-->"));
    if (timeIdx < 0) { result.push(block); continue; }

    const timeLine = lines[timeIdx].trim();
    const trans    = map[timeLine];

    if (!trans) { result.push(block); continue; }

    const textLines = lines.slice(timeIdx + 1);
    const origText  = textLines.join(" ").replace(/<[^>]+>/g, "").trim();

    const newBlock = [
      ...lines.slice(0, timeIdx + 1),
      ...(layout === "f"  ? [trans, origText] :
          layout === "tl" ? [trans] :
                            [origText, trans])
    ].join("\n");

    result.push(newBlock);
    hit++;
  }

  console.log("[YTDual] vtt hit=" + hit);
  return result.join("\n\n");
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

// ── 工具 ──────────────────────────────────────────────────────────────────────
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
