/*
 * YouTube 双字幕 v5.2 - 正确版
 *
 * srv3 结构：每两个相邻有内容的 <p> 组成一句话同时显示
 *   <p t="80"  d="3680">All right, Burger King has a beef with</p>   ← 上半句
 *   <p t="2080" d="3679">McDonald's. It all started with this</p>    ← 下半句
 *   同时显示这两个 <p> 是 YouTube 的正常渲染，无法避免
 *
 * 策略：
 *   翻译：两个 <p> 合并成整句一起翻译（保证语义完整）
 *   写回：
 *     第一个 <p> = 整句译文（中文）
 *     第二个 <p> = 整句原文（英文）
 *   这样两个 <p> 同时显示时，上面是中文，下面是英文，刚好两行
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
    const cacheKey = "YTDual52c_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      const entries = extractSentences(body, fmt);
      if (!entries.length) { safeReturn(body); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    safeReturn(result);

  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    safeReturn(body);
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 提取句子：两个 <p> 合并成一句
// ══════════════════════════════════════════════════════════════════════════════
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
    // 每两个合并成一句，key 用第一个 <p> 的时间戳
    for (let i = 0; i < pList.length; i += 2) {
      const a = pList[i], b = pList[i+1];
      const text = b ? (a.text + " " + b.text).trim() : a.text;
      entries.push({ key: String(a.ms), text });
    }
  }
  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// 合成双行
// ══════════════════════════════════════════════════════════════════════════════
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
          e.segs = [{ utf8: layout==="f" ? trans+"\n"+orig : layout==="tl" ? trans : orig+"\n"+trans }];
        }
      }
      return JSON.stringify(data);
    }

    if (fmt === "xml") {
      const pList = parseSRV3(body);
      if (!pList.length) { safeReturn(body); return body; }

      let result = body;

      for (let i = 0; i < pList.length; i += 2) {
        const first  = pList[i];
        const second = pList[i+1];

        // 整句原文
        const fullOrig = second ? (first.text + " " + second.text).trim() : first.text;
        // 找整句的译文（用第一个 <p> 的时间戳）
        const trans = map[String(first.ms)] || fuzzyGet(map, first.ms);
        if (!trans) continue;

        if (layout === "tl") {
          // 仅译文：两个 <p> 都显示译文
          const t = encodeHTML(trans);
          result = result.replace(first.full,  `<p ${first.attrs}>${t}</p>`);
          if (second) result = result.replace(second.full, `<p ${second.attrs}>${t}</p>`);
        } else if (layout === "f") {
          // 中文在上，英文在下：
          // 第一个 <p> 显示：译文（App 先显示这个）
          // 第二个 <p> 显示：译文\n原文（App 切到下半句时显示完整双行）
          // 这样两个 <p> 同时在屏幕上时：上面=译文，下面=译文\n原文 → 还是三行
          //
          // 正确做法：
          // 第一个 <p> = 译文
          // 第二个 <p> = 原文
          // App 同时显示两个 <p> 时：上=译文，下=原文 ✅ 刚好两行
          result = result.replace(first.full,  `<p ${first.attrs}>${encodeHTML(trans)}</p>`);
          if (second) result = result.replace(second.full, `<p ${second.attrs}>${encodeHTML(fullOrig)}</p>`);
        } else {
          // 英文在上，中文在下
          result = result.replace(first.full,  `<p ${first.attrs}>${encodeHTML(fullOrig)}</p>`);
          if (second) result = result.replace(second.full, `<p ${second.attrs}>${encodeHTML(trans)}</p>`);
        }
      }
      return result;
    }
  } catch(e) { console.log("[YTDual] compose ERR: " + e.message); }
  return body;
}

// ══════════════════════════════════════════════════════════════════════════════
// 解析 srv3 有内容的 <p> 列表
// ══════════════════════════════════════════════════════════════════════════════
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
    if (!text) continue;
    list.push({ ms: +tM[1], text, full: m[0], attrs: attrs.trim() });
  }
  return list;
}

// ══════════════════════════════════════════════════════════════════════════════
// 翻译
// ══════════════════════════════════════════════════════════════════════════════
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
    } catch(e) { console.log("[YTDual] translate fail: " + e.message); }
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

// ══════════════════════════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════════════════════════
function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{")) return "json3";
  if (t.startsWith("<")) return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 300) return map[k];
  }
  return null;
}

function parseURLParams(url) {
  const obj={}, qi=url.indexOf("?"); if(qi<0) return obj;
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

function decodeHTML(s) {
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c));
}
function encodeHTML(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
