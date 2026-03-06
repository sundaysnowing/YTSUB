/*
 * YouTube 双字幕 v5.0
 * 出错时原样返回 body（不返回空），确保字幕始终正常显示
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] 触发 len=" + (body||"").length + " fmt前20=" + (body||"").slice(0,20));

// 出错兜底：任何情况都返回原始 body
function safeReturn(b) { $done({ body: b || body }); }

if (!body || body.length < 10) { safeReturn(body); return; }

const SEP = "\n❖\n", CHUNK_MAX = 3500;
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
    const cacheKey = "YTDual50_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      const entries = extractEntries(body, fmt);
      console.log("[YTDual] entries=" + entries.length);
      if (!entries.length) { safeReturn(body); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] translated=" + Object.keys(transMap).length);
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    } else {
      console.log("[YTDual] cache hit=" + Object.keys(transMap).length);
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    safeReturn(result);

  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    safeReturn(body); // 出错返回原文，不返回空
  }
})();

// ── 提取字幕 ─────────────────────────────────────────────────────────────────
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
    } else if (fmt === "xml") {
      // srv3: <p t="ms" d="dur">word</p>  — 合并相邻词成句
      const words = [];
      body.replace(/<p\b[^>]*\bt="(\d+)"(?:[^>]*\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi,
        (_, t, d, c) => {
          const text = decodeHTML(c.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
          if (text) words.push({ ms: +t, dur: +(d||500), text });
        }
      );
      if (words.length) {
        // 分组：词间隔 > 1s 为新句
        let group = [words[0]];
        const flush = () => {
          if (!group.length) return;
          entries.push({ key: String(group[0].ms), text: group.map(w=>w.text).join(" ") });
          group = [];
        };
        for (let i = 1; i < words.length; i++) {
          if (words[i].ms - (words[i-1].ms + words[i-1].dur) > 1000) flush();
          group.push(words[i]);
        }
        flush();
      } else {
        // srv1: <text start="s">...</text>
        body.replace(/<text\b[^>]*\bstart="([^"]*)"[^>]*>([\s\S]*?)<\/text>/gi,
          (_, s, c) => {
            const ms   = Math.round(parseFloat(s)*1000);
            const text = decodeHTML(c.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
            if (text) entries.push({ key: String(ms), text });
          }
        );
      }
    }
  } catch(e) { console.log("[YTDual] extract err: " + e.message); }
  return entries;
}

// ── 合成双行 ─────────────────────────────────────────────────────────────────
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
      // srv3：找到每句第一个 <p>，写双行+延长时长，其余词清空
      const words = [];
      body.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (full, attrs, content, offset) => {
        const tM = attrs.match(/\bt="(\d+)"/);
        const dM = attrs.match(/\bd="(\d+)"/);
        if (!tM) return;
        const text = decodeHTML(content.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
        words.push({ full, attrs, ms: +tM[1], dur: +(dM?.[1]||500), text, offset });
      });

      if (!words.length) {
        // srv1 fallback
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

      // 分句
      const sentences = [];
      let grp = [words[0]];
      for (let i = 1; i < words.length; i++) {
        if (words[i].ms - (words[i-1].ms + words[i-1].dur) > 1000) {
          sentences.push(grp); grp = [];
        }
        grp.push(words[i]);
      }
      sentences.push(grp);

      // 逐句替换
      let result = body;
      let delta  = 0;
      let hit    = 0;

      for (const sent of sentences) {
        const first   = sent[0];
        const last    = sent[sent.length-1];
        const origTxt = sent.map(w=>w.text).filter(Boolean).join(" ");
        const trans   = map[String(first.ms)] || fuzzyGet(map, first.ms);
        if (!trans || !origTxt) continue;

        const totalDur = (last.ms + last.dur) - first.ms;

        // 替换第一个 <p>：延长时长，写双行
        const newAttrs = first.attrs
          .replace(/\bd="[^"]*"/, 'd="' + totalDur + '"')
          .replace(/^(?!.*\bd=)/, ''); // 如果没有 d 属性就不管
        const firstNew = "<p" + (newAttrs.includes('d="' + totalDur + '"') ? newAttrs : newAttrs + ' d="' + totalDur + '"') + ">"
          + encodeHTML(makeLine(origTxt, trans, layout)) + "</p>";

        const fi = result.indexOf(first.full, first.offset + delta - 50 < 0 ? 0 : first.offset + delta - 50);
        if (fi >= 0) {
          result = result.slice(0, fi) + firstNew + result.slice(fi + first.full.length);
          delta += firstNew.length - first.full.length;
          hit++;
        }

        // 清空同句后续 <p>
        for (let i = 1; i < sent.length; i++) {
          const w      = sent[i];
          const empty  = "<p" + w.attrs + "></p>";
          const wi     = result.indexOf(w.full, w.offset + delta - 200 < 0 ? 0 : w.offset + delta - 200);
          if (wi >= 0) {
            result = result.slice(0, wi) + empty + result.slice(wi + w.full.length);
            delta += empty.length - w.full.length;
          }
        }
      }

      console.log("[YTDual] srv3 hit=" + hit);
      return result;
    }
  } catch(e) {
    console.log("[YTDual] compose err: " + e.message);
  }
  return body;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

// ── 批量翻译 ─────────────────────────────────────────────────────────────────


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
  console.log("[YTDual] " + chunks.length + " batches");
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
        else reject(new Error("bad response"));
      } catch(e) { reject(e); }
    });
  });
}

// ── 工具 ─────────────────────────────────────────────────────────────────────
function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{"))      return "json3";
  if (t.startsWith("WEBVTT")) return "webvtt";
  if (t.startsWith("<"))      return "xml";
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
