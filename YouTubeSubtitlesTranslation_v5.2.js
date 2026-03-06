/*
 * YouTube 双字幕 v5.4 - 最终稳定版
 * 修复 ASR 字幕位置互换、三行重叠问题
 * 策略：强制同步配对标签的时间戳 (Time Synchronization)
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
    const cacheKey = `YTDual54_${videoId}_${TARGET_LANG}`;
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
    console.log(`[YTDual] 发生错误: ${e.message}`);
    safeReturn(body);
  }
})();

// --- 核心：提取并合并句子 ---
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

// --- 核心：合成并强制时间同步 ---
function composeDual(body, fmt, map, layout) {
  try {
    if (fmt === "json3") {
      const data = JSON.parse(body);
      for (const e of (data.events||[])) {
        if (!e.segs) continue;
        const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
        if (trans && trans !== orig) {
          e.segs = [{ utf8: layout==="f" ? trans+"\n"+orig : layout==="tl" ? trans : orig+"\n"+trans }];
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
        
        // 计算同步时间：起始时间设为 p1 的时间，总时长覆盖到 p2 结束
        const startTime = p1.ms;
        const endTime = p2 ? (p2.ms + p2.dur) : (p1.ms + p1.dur);
        const syncDur = endTime - startTime;

        // 清除旧的 t 和 d 属性，注入同步后的时间
        const cleanAttrs = (attr) => attr.replace(/\bt="\d+"|\bd="\d+"/g, '').trim();
        
        if (layout === "f") {
          // 中文在上：利用同步时间，让播放器稳定堆叠
          result = result.replace(p1.full, `<p t="${startTime}" d="${syncDur}" ${cleanAttrs(p1.attrs)}>${encodeHTML(trans)}</p>`);
          if (p2) result = result.replace(p2.full, `<p t="${startTime}" d="${syncDur}" ${cleanAttrs(p2.attrs)}>${encodeHTML(fullOrig)}</p>`);
        } else if (layout === "s") {
          // 英文在上
          result = result.replace(p1.full, `<p t="${startTime}" d="${syncDur}" ${cleanAttrs(p1.attrs)}>${encodeHTML(fullOrig)}</p>`);
          if (p2) result = result.replace(p2.full, `<p t="${startTime}" d="${syncDur}" ${cleanAttrs(p2.attrs)}>${encodeHTML(trans)}</p>`);
        } else {
          // 仅译文
          const t = encodeHTML(trans);
          result = result.replace(p1.full, `<p t="${startTime}" d="${syncDur}" ${cleanAttrs(p1.attrs)}>${t}</p>`);
          if (p2) result = result.replace(p2.full, `<p t="${startTime}" d="${syncDur}" ${cleanAttrs(p2.attrs)}>${t}</p>`);
        }
      }
      return result;
    }
  } catch(e) { console.log(`[YTDual] Compose Error: ${e.message}`); }
  return body;
}

// --- 工具函数：解析 srv3 增加时长捕捉 ---
function parseSRV3(body) {
  const list = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const attrs = m[1];
    if (/\ba=["']?1["']?/.test(attrs)) continue;
    const tM = attrs.match(/\bt="(\d+)"/);
    const dM = attrs.match(/\bd="(\d+)"/);
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
  for (const k of Object.keys(map)) { if (Math.abs(Number(k) - t) <= 400) return map[k]; }
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
