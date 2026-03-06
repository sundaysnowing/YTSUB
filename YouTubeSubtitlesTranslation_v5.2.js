/*
 * YouTube 双字幕 v5.2 - Loon 优化版
 * 修复 ASR 自动字幕三行显示问题，优化 srv3 匹配逻辑
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;
const url  = $request.url;
const body = $response.body;

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

(async () => {
  try {
    const cacheKey = "YTDual52_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      const entries = extractEntries(body, fmt);
      if (!entries.length) { safeReturn(body); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    safeReturn(result);

  } catch(e) {
    console.log("[YTDual] 发生错误: " + e.message);
    safeReturn(body);
  }
})();

// --- 核心逻辑：组装双语字幕 ---
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
      const pList = parseSRV3(body);
      if (pList.length > 0) {
        let result = body;
        // 优化点：采用 1:1 替换，不再强行合并写入，解决重叠显示问题
        for (const item of pList) {
          const trans = map[String(item.ms)] || fuzzyGet(map, item.ms);
          if (trans && trans !== item.text) {
            const dualLine = encodeHTML(makeLine(item.text, trans, layout));
            const newTag = `<p ${item.attrs}>${dualLine}</p>`;
            result = result.replace(item.full, newTag);
          }
        }
        return result;
      }
    }
  } catch(e) { console.log("[YTDual] 渲染出错: " + e.message); }
  return body;
}

function makeLine(orig, trans, layout) {
  const cleanOrig = orig.replace(/\s+/g, " ").trim(); // 清理原文中可能存在的换行符
  if (layout === "f")  return trans + "\n" + cleanOrig;
  if (layout === "tl") return trans;
  return cleanOrig + "\n" + trans;
}

// --- 其余工具函数 (保持并精简) ---
function extractEntries(body, fmt) {
  const entries = [];
  if (fmt === "json3") {
    const data = JSON.parse(body);
    for (const e of (data.events || [])) {
      if (!e.segs) continue;
      const text = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
      if (text) entries.push({ key: String(e.tStartMs||0), text });
    }
  } else if (fmt === "xml") {
    const pList = parseSRV3(body);
    for (const p of pList) {
      entries.push({ key: String(p.ms), text: p.text });
    }
  }
  return entries;
}

function parseSRV3(body) {
  const list = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const attrs = m[1];
    if (/\ba=["']?1["']?/.test(attrs)) continue;
    const tM = attrs.match(/\bt="(\d+)"/);
    if (!tM) continue;
    const text = decodeHTML(m[2].replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
    if (text) list.push({ ms: +tM[1], text, full: m[0], attrs });
  }
  return list;
}

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
    } catch(e) {}
  }
  return map;
}

function googleTranslate(text, tl) {
  return new Promise((resolve, reject) => {
    $httpClient.post({
      url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(tl) + "&dt=t&dj=1",
      headers: { "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"GoogleTranslate/6.29.59279 (iPhone; iOS 15.4)" },
      body: "q=" + encodeURIComponent(text),
    }, (err,_r,rb) => {
      if (err) return reject(err);
      try {
        const d = JSON.parse(rb);
        resolve(d.sentences.map(s=>s.trans||"").join(""));
      } catch(e) { reject(e); }
    });
  });
}

function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{")) return "json3";
  if (t.startsWith("<")) return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 200) return map[k];
  }
  return null;
}

function parseURLParams(url) {
  const obj={}; const qi=url.indexOf("?"); if(qi<0) return obj;
  url.slice(qi+1).split("&").forEach(p=>{
    const eq=p.indexOf("="); if(eq>=0) obj[decodeURIComponent(p.slice(0,eq))]=decodeURIComponent(p.slice(eq+1));
  }); return obj;
}

function parseArgs(str) {
  const obj={}; if(!str) return obj;
  str.split("&").forEach(p=>{ const eq=p.indexOf("="); if(eq>=0) obj[decodeURIComponent(p.slice(0,eq))]=decodeURIComponent(p.slice(eq+1)); });
  return obj;
}

function readCache(k){ try{return JSON.parse($persistentStore.read(k))}catch(e){return null} }
function writeCache(k,v){ $persistentStore.write(JSON.stringify(v),k) }
function decodeHTML(s){ return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
function encodeHTML(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }