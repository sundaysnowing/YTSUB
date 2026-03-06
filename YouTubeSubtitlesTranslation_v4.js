/*
 * YouTube 双字幕 v6.1 - 视觉稳定版
 * 修复：3行闪烁、中文消失、srv3 乱码
 * 策略：VTT 语义注入 + 严格标签占位保护
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;
const url  = $request.url;
const body = $response.body;

function safeReturn(b) { $done({ body: b || body }); }
if (!body || body.length < 10) { safeReturn(body); return; }

const ARGS = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl || "zh-Hans";
const LAYOUT = ARGS.line || "f";

const params = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { safeReturn(body); return; }

(async () => {
  try {
    const cacheKey = `YTVTT_v61_${videoId}_${TARGET_LANG}`;
    let transMap = readCache(cacheKey);

    if (!transMap) {
      // 1. 尝试获取完整语义的 VTT 接口
      const vttUrl = url.replace(/fmt=srv\d/, "fmt=vtt");
      const vttBody = await fetchVTT(vttUrl);
      const entries = vttBody ? extractVTT(vttBody) : extractSRV3Entries(body);
      
      if (!entries.length) { safeReturn(body); return; }
      transMap = await translateAll(entries, TARGET_LANG);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    }

    // 2. 将翻译注入回原 XML，并处理闪烁问题
    const result = injectDualStabilized(body, transMap, LAYOUT);
    safeReturn(result);
  } catch(e) {
    console.log(`[YTDual] v6.1 Error: ${e.message}`);
    safeReturn(body);
  }
})();

// --- 语义提取 ---
function fetchVTT(vUrl) {
  return new Promise((resolve) => {
    $httpClient.get(vUrl, (err, resp, data) => {
      if (err || !data || !data.includes("WEBVTT")) resolve(null);
      else resolve(data);
    });
  });
}

function extractVTT(vtt) {
  const entries = [];
  const lines = vtt.split(/\r?\n/);
  const timeRe = /(\d{2}:\d{2}:\d{2}.\d{3}) --> (\d{2}:\d{2}:\d{2}.\d{3})/;
  for (let i = 0; i < lines.length; i++) {
    if (timeRe.test(lines[i])) {
      let text = (lines[i+1] || "").trim();
      if (text) {
        let ms = timeToMs(lines[i].match(timeRe)[1]);
        entries.push({ key: String(ms), text: decodeHTML(text) });
      }
    }
  }
  return entries;
}

function extractSRV3Entries(xml) {
  const list = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tM = m[1].match(/\bt="(\d+)"/);
    const text = decodeHTML(m[2].replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
    if (tM && text) list.push({ key: tM[1], text });
  }
  return list;
}

// --- 核心：稳定注入逻辑 ---
function injectDualStabilized(xml, map, layout) {
  const pList = parseSRV3Full(xml);
  if (!pList.length) return xml;
  
  let result = xml;
  // 记录已合并的时间戳，防止重复渲染
  const processed = new Set();

  for (let i = 0; i < pList.length; i++) {
    const p1 = pList[i];
    if (processed.has(p1.ms)) continue;

    const trans = fuzzyGet(map, p1.ms);
    if (!trans) continue;

    const p2 = pList[i+1];
    // 检查 p2 是否是紧随其后的“流式片段”
    const isFragment = p2 && (p2.ms - p1.ms < 2500);

    const fullOrig = isFragment ? (p1.text + " " + p2.text).trim() : p1.text;
    const dual = layout === "f" ? `${trans}\n${fullOrig}` : layout === "tl" ? trans : `${fullOrig}\n${trans}`;

    // 更新当前标签
    const newP = `<p t="${p1.ms}" d="${isFragment ? (p2.ms + p2.dur - p1.ms) : p1.dur}" ${p1.attrs.replace(/\bt="\d+"|\bd="\d+"/g, "").trim()}>${encodeHTML(dual)}</p>`;
    result = result.replace(p1.full, newP);
    processed.add(p1.ms);

    if (isFragment) {
      // 关键：将紧随其后的 p2 彻底抹除，防止 3 行闪烁
      const emptyP2 = `<p t="${p2.ms}" d="0" ${p2.attrs.replace(/\bt="\d+"|\bd="\d+"/g, "").trim()}></p>`;
      result = result.replace(p2.full, emptyP2);
      processed.add(p2.ms);
    }
  }
  return result;
}

// --- 工具函数 ---
function parseSRV3Full(xml) {
  const list = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    if (/\ba=["']?1["']?/.test(attrs)) continue;
    const tM = attrs.match(/\bt="(\d+)"/), dM = attrs.match(/\bd="(\d+)"/);
    if (!tM) continue;
    const text = decodeHTML(m[2].replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
    list.push({ ms: +tM[1], dur: +(dM?.[1]||2000), text, full: m[0], attrs: attrs.trim() });
  }
  return list;
}

function timeToMs(t) {
  const p = t.split(/:|\./);
  return (parseInt(p[0])*3600 + parseInt(p[1])*60 + parseInt(p[2]))*1000 + parseInt(p[3]);
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
      headers: { "Content-Type":"application/x-www-form-urlencoded", "User-Agent":"GoogleTranslate/6.29.59279" },
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
  const keys = Object.keys(map).map(Number).sort((a,b)=>a-b);
  for (let k of keys) { if (t >= k - 500 && t < k + 3500) return map[String(k)]; }
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
function decodeHTML(s) { return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ").replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c)); }
function encodeHTML(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
