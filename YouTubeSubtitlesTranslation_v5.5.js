/*
 * YouTube 双字幕 v5.5 - 终极稳定版
 * 修复：字幕位置互换 (Alternating Positions)、三行重叠 (Triple Lines)
 * 策略：单标签双行化 - 合并 p1&p2 至 p1，清空 p2，强制时长同步
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

const fmt = detectFormat(body);
if (fmt === "unknown") { safeReturn(body); return; }

(async () => {
  try {
    const cacheKey = `YTDual55_${videoId}_${TARGET_LANG}`;
    let transMap = readCache(cacheKey);

    if (!transMap) {
      const entries = extractSentences(body, fmt);
      if (!entries.length) { safeReturn(body); return; }
      transMap = await translateAll(entries, TARGET_LANG);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    safeReturn(result);
  } catch(e) {
    console.log(`[YTDual] Error: ${e.message}`);
    safeReturn(body);
  }
})();

// --- 提取与合并逻辑 ---
function extractSentences(body, fmt) {
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

// --- 合并写入逻辑 (解决互换问题的关键) ---
function composeDual(body, fmt, map, layout) {
  try {
    if (fmt === "json3") {
      const data = JSON.parse(body);
      for (const e of (data.events||[])) {
        if (!e.segs) continue;
        const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
        if (trans && trans !== orig) {
          const line = layout==="f" ? trans+"\n"+orig : layout==="tl" ? trans : orig+"\n"+trans;
          e.segs = [{ utf8: line }];
        }
      }
      return JSON.stringify(data);
    }

    if (fmt === "xml") {
      const pList = parseSRV3(body);
      if (!pList.length) return body;
      let result = body;

      for (let i = 0; i < pList.length; i += 2) {
        const p1 = pList[i];
        const p2 = pList[i+1];
        const trans = map[String(p1.ms)] || fuzzyGet(map, p1.ms);
        if (!trans) continue;

        const fullOrig = p2 ? (p1.text + " " + p2.text).trim() : p1.text;
        const syncDur = p2 ? (p2.ms + p2.dur - p1.ms) : p1.dur;
        
        // 构造双语内容
        const dualText = layout==="f" ? trans+"\n"+fullOrig : layout==="tl" ? trans : fullOrig+"\n"+trans;
        
        // 核心修改：将 p1 变为双语并延长时长，将 p2 彻底抹除内容
        // 这样播放器在同一时刻只会渲染一个标签，位置永远不会乱跳
        const newP1 = `<p t="${p1.ms}" d="${syncDur}" ${p1.attrs.replace(/\bt="\d+"|\bd="\d+"/g, "").trim()}>${encodeHTML(dualText)}</p>`;
        result = result.replace(p1.full, newP1);
        
        if (p2) {
          // 清空 p2 的内容，防止重叠
          const emptyP2 = `<p t="${p1.ms}" d="${syncDur}" ${p2.attrs.replace(/\bt="\d+"|\bd="\d+"/g, "").trim()}></p>`;
          result = result.replace(p2.full, emptyP2);
        }
      }
      return result;
    }
  } catch(e) { console.log(`[YTDual] Compose Error: ${e.message}`); }
  return body;
}

// --- 工具函数 ---
function parseSRV3(body) {
  const list = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const attrs = m[1];
    if (/\ba=["']?1["']?/.test(attrs)) continue;
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

function detectFormat(body) {
  const t = (body||"").trimStart();
  return t.startsWith("{") ? "json3" : (t.startsWith("<") ? "xml" : "unknown");
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
function decodeHTML(s) { return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c)); }
function encodeHTML(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }