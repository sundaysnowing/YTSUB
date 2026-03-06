/*
 * YouTube 双字幕 v5.8 - VTT 语义注入版
 * 修复：SRV3 导致的断句破碎、消失、位置乱跳
 * 策略：保持 srv3 结构以兼容 App，但在后台拉取 vtt 获取完整语义 
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;
const url  = $request.url;
const body = $response.body;

function safeReturn(b) { $done({ body: b || body }); }
if (!body || body.length < 10) { safeReturn(body); return; }

const ARGS = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl || "zh-Hans";
const LAYOUT = ARGS.line || "f";

// 提取视频 ID 和原始请求参数 
const params = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { safeReturn(body); return; }

(async () => {
  try {
    const cacheKey = `YTVTT_${videoId}_${TARGET_LANG}`;
    let transMap = readCache(cacheKey);

    if (!transMap) {
      // 核心思路：尝试从 VTT 接口获取更高质量的文本块 
      const vttUrl = url.replace(/fmt=srv\d/, "fmt=vtt");
      const vttBody = await fetchVTT(vttUrl);
      const entries = vttBody ? extractVTT(vttBody) : extractSRV3(body);
      
      if (!entries.length) { safeReturn(body); return; }
      transMap = await translateAll(entries, TARGET_LANG);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    }

    // 将 VTT 级别的译文映射回 App 要求的 srv3 XML 
    const result = injectDual(body, transMap, LAYOUT);
    safeReturn(result);
  } catch(e) {
    console.log(`[YTDual] VTT Inject Error: ${e.message}`);
    safeReturn(body);
  }
})();

// 拉取 VTT 格式字幕 
function fetchVTT(vUrl) {
  return new Promise((resolve) => {
    $httpClient.get(vUrl, (err, resp, data) => {
      if (err || !data || !data.includes("WEBVTT")) resolve(null);
      else resolve(data);
    });
  });
}

// 解析 VTT 获取完整句子 
function extractVTT(vtt) {
  const entries = [];
  const lines = vtt.split(/\r?\n/);
  let timestampRe = /(\d{2}:\d{2}:\d{2}.\d{3}) --> (\d{2}:\d{2}:\d{2}.\d{3})/;
  for (let i = 0; i < lines.length; i++) {
    if (timestampRe.test(lines[i])) {
      let text = lines[i+1] ? lines[i+1].trim() : "";
      if (text) {
        let ms = timeToMs(lines[i].match(timestampRe)[1]);
        entries.push({ key: String(ms), text });
      }
    }
  }
  return entries;
}

// 解析原始 srv3
function extractSRV3(xml) {
  const list = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tM = m[1].match(/\bt="(\d+)"/);
    if (!tM) continue;
    const text = m[2].replace(/<[^>]+>/g," ").trim();
    if (text) list.push({ key: tM[1], text });
  }
  return list;
}

// 注入回 srv3 结构
function injectDual(xml, map, layout) {
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  return xml.replace(re, (full, attrs, content) => {
    const tM = attrs.match(/\bt="(\d+)"/);
    if (!tM) return full;
    const trans = fuzzyGet(map, tM[1]);
    if (!trans) return full;
    
    const orig = content.replace(/<[^>]+>/g," ").trim();
    const dual = layout === "f" ? `${trans}\n${orig}` : layout === "tl" ? trans : `${orig}\n${trans}`;
    return `<p ${attrs}>${encodeHTML(dual)}</p>`;
  });
}

// --- 工具函数 ---
function timeToMs(t) {
  const parts = t.split(/:|./);
  return (parseInt(parts[0])*3600 + parseInt(parts[1])*60 + parseInt(parts[2]))*1000 + parseInt(parts[3]);
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
      t.split(/❖/).forEach((s,i) => { if (chunk[i]) map[chunk[i].key] = s.trim(); });
    } catch(e) {}
  }
  return map;
}

function googleTranslate(text, tl) {
  return new Promise((resolve, reject) => {
    $httpClient.post({
      url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&dj=1`,
      headers: { "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"GoogleTranslate/6.29.59279 (iPhone; iOS 15.4)" },
      body: `q=${encodeURIComponent(text)}`,
    }, (err,_r,rb) => {
      if (err) return reject(err);
      try {
        const d = JSON.parse(rb);
        resolve(d.sentences.map(s=>s.trans||"").join(""));
      } catch(e) { reject(e); }
    });
  });
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  const keys = Object.keys(map).map(Number).sort((a,b) => a-b);
  for (let k of keys) {
    if (t >= k && t < k + 3000) return map[String(k)]; 
  }
  return null;
}

function parseURLParams(url) {
  const obj={}; const qi=url.indexOf("?"); if(qi<0) return obj;
  url.slice(qi+1).split("&").forEach(p=>{
    const eq=p.indexOf("="); if(eq>=0) try{obj[decodeURIComponent(p.slice(0,eq))]=decodeURIComponent(p.slice(eq+1));}catch(_){}
  }); return obj;
}

function parseArgs(str) {
  const obj={}; if(!str) return obj;
  str.split("&").forEach(p=>{ const eq=p.indexOf("="); if(eq>=0) try{obj[decodeURIComponent(p.slice(0,eq))]=decodeURIComponent(p.slice(eq+1));}catch(_){} });
  return obj;
}

function readCache(k) { try{return JSON.parse($persistentStore.read(k))}catch(e){return null} }
function writeCache(k,v) { try{$persistentStore.write(JSON.stringify(v),k)}catch(e){} }
function encodeHTML(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
