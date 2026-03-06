/*
 * YouTube 双字幕 v6.0 - 物理合并版
 * 策略：合并 srv3 标签，拉长显示时长，彻底解决 3 行变 2 行的闪烁感
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
    const cacheKey = `YTDualV6_${videoId}_${TARGET_LANG}`;
    let transMap = readCache(cacheKey);

    if (!transMap) {
      const entries = extractSentences(body);
      if (!entries.length) { safeReturn(body); return; }
      transMap = await translateAll(entries, TARGET_LANG);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    }

    const result = composeFinal(body, transMap, LAYOUT);
    safeReturn(result);
  } catch(e) {
    console.log(`[YTDual] Error: ${e.message}`);
    safeReturn(body);
  }
})();

// --- 核心逻辑：提取并合并意群 ---
function extractSentences(xml) {
  const entries = [];
  const pList = parseSRV3Full(xml);
  // 每两个 <p> 合并为一个逻辑句进行翻译，确保语义连贯
  for (let i = 0; i < pList.length; i += 2) {
    const a = pList[i], b = pList[i+1];
    const text = b ? (a.text + " " + b.text).trim() : a.text;
    entries.push({ key: String(a.ms), text });
  }
  return entries;
}

// --- 核心逻辑：重构 XML 结构 (解决 3 行的关键) ---
function composeFinal(xml, map, layout) {
  const pList = parseSRV3Full(xml);
  if (!pList.length) return xml;
  
  let result = xml;
  for (let i = 0; i < pList.length; i += 2) {
    const p1 = pList[i], p2 = pList[i+1];
    const trans = map[String(p1.ms)] || fuzzyGet(map, p1.ms);
    if (!trans) continue;

    // 计算合并后的总原文和总时长
    const fullOrig = p2 ? (p1.text + " " + p2.text).trim() : p1.text;
    const totalDur = p2 ? (p2.ms + p2.dur - p1.ms) : p1.dur;
    
    // 构造双语内容
    const dualText = layout === "f" ? `${trans}\n${fullOrig}` : layout === "tl" ? trans : `${fullOrig}\n${trans}`;
    
    // 修改 P1：注入双语，并将时长设置为覆盖整句的时长
    const newP1 = `<p t="${p1.ms}" d="${totalDur}" ${p1.attrs.replace(/\bt="\d+"|\bd="\d+"/g, "").trim()}>${encodeHTML(dualText)}</p>`;
    result = result.replace(p1.full, newP1);

    if (p2) {
      // 抹除 P2：将其内容设为空，时长设为 0，防止它弹出干扰渲染
      const emptyP2 = `<p t="${p2.ms}" d="0" ${p2.attrs.replace(/\bt="\d+"|\bd="\d+"/g, "").trim()}></p>`;
      result = result.replace(p2.full, emptyP2);
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
    if (/\ba=["']?1["']?/.test(attrs)) continue; // 跳过逐词渲染标签
    const tM = attrs.match(/\bt="(\d+)"/), dM = attrs.match(/\bd="(\d+)"/);
    if (!tM) continue;
    const text = decodeHTML(m[2].replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
    if (!text) continue;
    list.push({ ms: +tM[1], dur: +(dM?.[1]||2000), text, full: m[0], attrs: attrs.trim() });
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
  for (const k of Object.keys(map)) { if (Math.abs(Number(k) - t) <= 450) return map[k]; }
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
