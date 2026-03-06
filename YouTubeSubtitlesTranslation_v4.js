/*
 * YouTube 双字幕 v5.1
 *
 * srv3 结构：每两个相邻有内容的 <p> 同时显示
 * 策略：每对 <p> 合并成一句翻译，两个 <p> 都写相同双行内容
 * 出错时原样返回，不报"加载字幕时出错"
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] 触发 len=" + (body||"").length);

function safeReturn(b) { $done({ body: b || body }); }

if (!body || body.length < 10) { safeReturn(body); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { safeReturn(body); return; }

const fmt = detectFormat(body);
console.log("[YTDual] fmt=" + fmt + " videoId=" + videoId);
if (fmt === "unknown") { safeReturn(body); return; }

(async () => {
  try {
    const cacheKey = "YTDual51_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      const entries = extractEntries(body, fmt);
      console.log("[YTDual] entries=" + entries.length + (entries[0] ? " 首条: " + entries[0].text.slice(0,30) : ""));
      if (!entries.length) { safeReturn(body); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] translated=" + Object.keys(transMap).length);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    } else {
      console.log("[YTDual] cache=" + Object.keys(transMap).length);
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    safeReturn(result);

  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    safeReturn(body);
  }
})();

function extractEntries(body, fmt) {
  const entries = [];
  try {
    if (fmt === "json3") {
      const data = JSON.parse(body);
      for (const e of (data.events || [])) {
        if (!e.segs) continue;
        const text = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(e.tStartMs||0), text });
      }
      return entries;
    }
    if (fmt === "xml") {
      const pList = parseSRV3(body);
      if (pList.length) {
        for (let i = 0; i < pList.length; i += 2) {
          const a = pList[i], b = pList[i+1];
          const text = b ? a.text + " " + b.text : a.text;
          entries.push({ key: String(a.ms), text: text.trim() });
        }
        return entries;
      }
      body.replace(/<text\b[^>]*\bstart="([^"]*)"[^>]*>([\s\S]*?)<\/text>/gi, (_, s, c) => {
        const ms   = Math.round(parseFloat(s)*1000);
        const text = decodeHTML(c.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(ms), text });
      });
    }
  } catch(e) { console.log("[YTDual] extract err: " + e.message); }
  return entries;
}

function parseSRV3(body) {
  const list = [];
  const re   = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const attrs = m[1];
    if (/\ba=["']?1["']?/.test(attrs)) continue;
    const tM = attrs.match(/\bt="(\d+)"/);
    const dM = attrs.match(/\bd="(\d+)"/);
    if (!tM) continue;
    const text = decodeHTML(m[2].replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
    if (!text) continue;
    list.push({ ms: +tM[1], dur: +(dM?.[1]||2000), text, full: m[0], attrs, index: m.index });
  }
  return list;
}

function composeDual(body, fmt, map, layout) {
  try {
    if (fmt === "json3") {
      const data = JSON.parse(body);
      let hit = 0;
      for (const e of (data.events||[])) {
        if (!e.segs) continue;
        const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (!orig) continue;
        const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
        if (!trans || trans === orig) continue;
        e.segs = [{ utf8: makeLine(orig, trans, layout) }];
        hit++;
      }
      console.log("[YTDual] json3 hit=" + hit);
      return JSON.stringify(data);
    }
    if (fmt === "xml") {
      const pList = parseSRV3(body);
      if (!pList.length) {
        let hit = 0;
        return body.replace(/<text\b([^>]*\bstart="([^"]*)"[^>]*)>([\s\S]*?)<\/text>/gi,
          (full, attrs, s, c) => {
            const ms   = Math.round(parseFloat(s)*1000);
            const orig = decodeHTML(c.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
            if (!orig) return full;
            const trans = map[String(ms)] || fuzzyGet(map, ms);
            if (!trans || trans === orig) return full;
            hit++;
            return "<text" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</text>";
          }
        );
      }

      let result = body, delta = 0, hit = 0;

      for (let i = 0; i < pList.length; i += 2) {
        const first  = pList[i];
        const second = pList[i+1];
        const origText = second ? first.text + " " + second.text : first.text;
        const trans    = map[String(first.ms)] || fuzzyGet(map, first.ms);
        if (!trans) continue;

        const dualLine = encodeHTML(makeLine(origText.trim(), trans, layout));

        // 两个 <p> 都写相同双行内容
        const firstNew = "<p" + first.attrs + ">" + dualLine + "</p>";
        const fi = result.indexOf(first.full, Math.max(0, first.index + delta - 50));
        if (fi >= 0) {
          result = result.slice(0, fi) + firstNew + result.slice(fi + first.full.length);
          delta += firstNew.length - first.full.length;
          hit++;
        }
        if (second) {
          const secondNew = "<p" + second.attrs + ">" + dualLine + "</p>";
          const si = result.indexOf(second.full, Math.max(0, second.index + delta - 200));
          if (si >= 0) {
            result = result.slice(0, si) + secondNew + result.slice(si + second.full.length);
            delta += secondNew.length - second.full.length;
          }
        }
      }
      console.log("[YTDual] srv3 hit=" + hit);
      return result;
    }
  } catch(e) { console.log("[YTDual] compose err: " + e.message); }
  return body;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
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
  for (let ci = 0; ci < chunks.length; ci++) {
    try {
      const t = await googleTranslate(chunks[ci].map(e=>e.text).join(SEP), tl);
      t.split(/❖/).forEach((s,i) => {
        const c = s.trim();
        if (c && chunks[ci][i]) map[chunks[ci][i].key] = c;
      });
    } catch(e) { console.log("[YTDual] batch" + ci + " fail: " + e.message); }
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
      if (err) { reject(new Error(String(err))); return; }
      try {
        const d = JSON.parse(rb);
        if (Array.isArray(d.sentences)) resolve(d.sentences.map(s=>s.trans||"").join("").trim());
        else reject(new Error("bad resp"));
      } catch(e) { reject(e); }
    });
  });
}

function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{"))   return "json3";
  if (t.startsWith("WEB")) return "webvtt";
  if (t.startsWith("<"))   return "xml";
  return "unknown";
}

function fuzzyGet(map, tMs) {
  const t = Number(tMs);
  for (const k of Object.keys(map)) {
    if (Math.abs(Number(k) - t) <= 500) return map[k];
  }
  return null;
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

function readCache(key) {
  try { const r=$persistentStore.read(key); return r?JSON.parse(r):null; } catch(_){return null;}
}

function writeCache(key, obj) {
  try { $persistentStore.write(JSON.stringify(obj), key); } catch(_){}
}

function decodeHTML(s) {
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
    .replace(/&#(\d+);/g,(_,c)=>String.fromCharCode(+c))
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
}

function encodeHTML(s) {
  return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
