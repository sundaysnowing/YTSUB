/*
 * YouTube 双字幕 v4.8
 *
 * 只做一件事：http-response 拦截，不修改请求。
 * srv3 逐词重叠问题的解法：
 *   按 <p> 的 d（duration）属性把同一时间窗口内的词合并成一句，
 *   只在第一个 <p> 写双行，其余 <p> 清空。
 *   同时把第一个 <p> 的 d 值延长到整句结束时间，避免提前消失。
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] 触发 url=" + url.slice(0,100));
console.log("[YTDual] body前30=" + (body||"").slice(0,30));

if (!body || body.length < 10) { $done({}); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { $done({}); return; }

const fmt = detectFormat(body);
console.log("[YTDual] 格式=" + fmt + " videoId=" + videoId);
if (fmt === "unknown") { $done({}); return; }

(async () => {
  try {
    const cacheKey = "YTDual48_" + videoId + "_" + TARGET_LANG;
    let transMap   = readCache(cacheKey);

    if (!transMap) {
      // 提取字幕条目翻译
      const entries = extractEntries(body, fmt);
      console.log("[YTDual] 提取 " + entries.length + " 条");
      if (!entries.length) { $done({}); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] 翻译 " + Object.keys(transMap).length + " 条");
      if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
    } else {
      console.log("[YTDual] 缓存命中 " + Object.keys(transMap).length + " 条");
    }

    const result = composeDual(body, fmt, transMap, LAYOUT);
    console.log("[YTDual] ✅ 完成，返回");
    $done({ body: result });

  } catch(e) {
    console.log("[YTDual] 异常: " + e.message);
    $done({});
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// 提取字幕条目
// json3：直接按事件提取
// srv3/xml：把相邻词合并成句（间隔 > 1s 认为是新句）
// ══════════════════════════════════════════════════════════════════════════════
function extractEntries(body, fmt) {
  if (fmt === "json3") {
    const entries = [];
    try {
      const data = JSON.parse(body);
      for (const e of (data.events||[])) {
        if (!Array.isArray(e.segs)) continue;
        const text = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(e.tStartMs||0), text });
      }
    } catch(e) {}
    return entries;
  }

  if (fmt === "xml") {
    // 收集所有 <p t="ms" d="dur"> 节点
    const words = [];
    const pRe   = /<p\b[^>]*\bt="(\d+)"(?:[^>]*\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRe.exec(body)) !== null) {
      const text = decodeHTML(m[3].replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
      if (text) words.push({ ms: parseInt(m[1]), dur: parseInt(m[2]||"0"), text });
    }

    if (!words.length) {
      // srv1/srv2 fallback
      const entries = [];
      const tRe = /<text\b[^>]*\bstart="([^"]*)"[^>]*>([\s\S]*?)<\/text>/gi;
      while ((m = tRe.exec(body)) !== null) {
        const ms   = Math.round(parseFloat(m[1])*1000);
        const text = decodeHTML(m[2].replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
        if (text) entries.push({ key: String(ms), text });
      }
      return entries;
    }

    // 按间隔分组（> 1000ms 认为是新句）
    const sentences = [];
    let group = [words[0]];
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].ms - (words[i-1].ms + words[i-1].dur);
      if (gap > 1000) { sentences.push(group); group = []; }
      group.push(words[i]);
    }
    if (group.length) sentences.push(group);

    return sentences.map(g => ({
      key:  String(g[0].ms),
      text: g.map(w=>w.text).join(" "),
      endMs: g[g.length-1].ms + g[g.length-1].dur,
      words: g,
    }));
  }

  return [];
}

// ══════════════════════════════════════════════════════════════════════════════
// 合成双行
// ══════════════════════════════════════════════════════════════════════════════
function composeDual(body, fmt, map, layout) {
  if (fmt === "json3") {
    let data;
    try { data = JSON.parse(body); } catch(e) { return body; }
    let hit = 0;
    for (const e of (data.events||[])) {
      if (!Array.isArray(e.segs)) continue;
      const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
      if (!orig) continue;
      const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
      if (!trans || trans === orig) continue;
      e.segs = [{ utf8: makeLine(orig, trans, layout) }];
      hit++;
    }
    console.log("[YTDual] json3 命中 " + hit);
    return JSON.stringify(data);
  }

  if (fmt === "xml") {
    // 重建句子列表（带 endMs）
    const words = [];
    const pRe   = /<p\b[^>]*\bt="(\d+)"(?:[^>]*\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRe.exec(body)) !== null) {
      const text = decodeHTML(m[3].replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
      words.push({ ms: parseInt(m[1]), dur: parseInt(m[2]||"500"), text, full: m[0], attrs: m[1+1], index: m.index });
    }

    if (!words.length) {
      // srv1 fallback
      let hit = 0;
      return body.replace(/<text\b([^>]*\bstart="([^"]*)"[^>]*)>([\s\S]*?)<\/text>/gi,
        (full, attrs, s, content) => {
          const ms   = Math.round(parseFloat(s)*1000);
          const orig = decodeHTML(content.replace(/<[^>]+>/g,"")).replace(/\n/g," ").trim();
          if (!orig) return full;
          const trans = map[String(ms)] || fuzzyGet(map, ms);
          if (!trans || trans === orig) return full;
          hit++;
          return "<text" + attrs + ">" + encodeHTML(makeLine(orig, trans, layout)) + "</text>";
        }
      );
    }

    // 重新分组成句
    const sentences = [];
    let group = [words[0]];
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].ms - (words[i-1].ms + words[i-1].dur);
      if (gap > 1000) { sentences.push(group); group = []; }
      group.push(words[i]);
    }
    if (group.length) sentences.push(group);

    // 对每句，重建 <p> 节点
    // 第一个 <p>：写双行，d 延长到整句结束
    // 其余 <p>：清空内容
    let result = body;
    let offset = 0;
    let hit    = 0;

    for (const sentence of sentences) {
      const firstWord = sentence[0];
      const lastWord  = sentence[sentence.length-1];
      const origText  = sentence.map(w=>w.text).filter(Boolean).join(" ");
      const trans     = map[String(firstWord.ms)] || fuzzyGet(map, firstWord.ms);
      if (!trans || !origText) continue;

      // 整句时长
      const totalDur = (lastWord.ms + lastWord.dur) - firstWord.ms;

      // 重新找到第一个词的 <p> 标签并替换
      // 原始 attrs 字符串里的 d 值需要更新
      const origTag  = firstWord.full;
      // 把 d="xxx" 改成整句时长，或追加
      let newAttrs = origTag.match(/^<p([^>]*)>/i)?.[1] || "";
      newAttrs = newAttrs.replace(/\bd="[^"]*"/, 'd="' + totalDur + '"');
      if (!newAttrs.includes('d="')) newAttrs += ' d="' + totalDur + '"';
      const newTag = "<p" + newAttrs + ">" + encodeHTML(makeLine(origText, trans, layout)) + "</p>";

      const ri = result.indexOf(origTag, firstWord.index + offset - 100 < 0 ? 0 : firstWord.index + offset - 100);
      if (ri >= 0) {
        result  = result.slice(0, ri) + newTag + result.slice(ri + origTag.length);
        offset += newTag.length - origTag.length;
        hit++;
      }

      // 清空同句后续词
      for (let i = 1; i < sentence.length; i++) {
        const w      = sentence[i];
        const wTag   = w.full;
        let wAttrs   = wTag.match(/^<p([^>]*)>/i)?.[1] || "";
        const emptyP = "<p" + wAttrs + "></p>";
        const wi     = result.indexOf(wTag, w.index + offset - 200 < 0 ? 0 : w.index + offset - 200);
        if (wi >= 0) {
          result  = result.slice(0, wi) + emptyP + result.slice(wi + wTag.length);
          offset += emptyP.length - wTag.length;
        }
      }
    }

    console.log("[YTDual] srv3 命中 " + hit + " 句");
    return result;
  }

  return body;
}

function makeLine(orig, trans, layout) {
  if (layout === "f")  return trans + "\n" + orig;
  if (layout === "tl") return trans;
  return orig + "\n" + trans;
}

// ══════════════════════════════════════════════════════════════════════════════
// 批量翻译
// ══════════════════════════════════════════════════════════════════════════════
const SEP = "\n❖\n", CHUNK_MAX = 3500;

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
      const translated = await googleTranslate(chunks[ci].map(e=>e.text).join(SEP), tl);
      translated.split(/❖/).forEach((t,i) => {
        const clean = t.trim();
        if (clean && chunks[ci][i]) map[chunks[ci][i].key] = clean;
      });
    } catch(e) { console.log("[YTDual] 批次" + (ci+1) + " 失败: " + e.message); }
  }
  return map;
}

function googleTranslate(text, tl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("超时")), 15000);
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
        else reject(new Error("格式异常"));
      } catch(e) { reject(e); }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════════════════════════
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
