/*
 * YouTube 双字幕 v5.2
 *
 * 核心方案：
 *   请求阶段：把 fmt=srv3 改成 fmt=json3（json3 每条是完整一句，不重叠）
 *   响应阶段：翻译 json3 合成双行返回
 *   响应头：移除 content-encoding 和 content-length，让 App 正确解析
 *
 * 之前 v4.3 报错的原因：响应头里保留了 content-encoding:gzip
 * 但我们返回的是明文 json，导致 App 解压失败。
 * 这次彻底清理响应头。
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

// 判断是 request 还是 response
if (typeof $response === "undefined") {
  // ── 请求阶段：把任何 fmt 改成 json3 ────────────────────────────────────────
  const url = $request.url;
  console.log("[YTDual] REQ " + url.slice(0, 100));

  let newUrl = url;
  // 替换所有 fmt= 或 format= 参数为 json3
  newUrl = newUrl.replace(/([?&])(fmt|format)=([^&]*)/g, "$1fmt=json3");
  // 如果完全没有 fmt 参数则追加
  if (!/[?&]fmt=/.test(newUrl)) newUrl += "&fmt=json3";

  if (newUrl !== url) {
    console.log("[YTDual] 改为 json3");
    $done({ url: newUrl });
  } else {
    $done({});
  }

} else {
  // ── 响应阶段：翻译并合成双行 ────────────────────────────────────────────────
  const url  = $request.url;
  const body = $response.body;

  console.log("[YTDual] RESP len=" + (body||"").length + " 前20=" + (body||"").slice(0,20));

  function safeReturn(b) {
    // 清理响应头，移除 gzip 和 content-length
    const h = {};
    for (const k of Object.keys($response.headers || {})) {
      const kl = k.toLowerCase();
      if (kl === "content-encoding" || kl === "content-length") continue;
      h[k] = $response.headers[k];
    }
    $done({ body: b || body, headers: h });
  }

  if (!body || body.length < 10) { safeReturn(body); return; }

  const fmt = detectFormat(body);
  console.log("[YTDual] fmt=" + fmt);

  // 如果不是 json3 说明请求阶段没有生效，原样返回
  if (fmt !== "json3") {
    console.log("[YTDual] 非 json3，原样返回");
    safeReturn(body);
    return;
  }

  const params  = parseURLParams(url);
  const videoId = params.v || params.videoId || "";
  if (!videoId) { safeReturn(body); return; }

  (async () => {
    try {
      const cacheKey = "YTDual52_" + videoId + "_" + TARGET_LANG;
      let transMap   = readCache(cacheKey);

      if (!transMap) {
        // 解析 json3 字幕条目
        const entries = [];
        try {
          const data = JSON.parse(body);
          for (const e of (data.events || [])) {
            if (!e.segs) continue;
            const text = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
            if (text) entries.push({ key: String(e.tStartMs||0), text });
          }
        } catch(e) { console.log("[YTDual] parse err: " + e.message); }

        console.log("[YTDual] entries=" + entries.length);
        if (!entries.length) { safeReturn(body); return; }

        transMap = await translateAll(entries, TARGET_LANG);
        console.log("[YTDual] translated=" + Object.keys(transMap).length);
        if (Object.keys(transMap).length > 0) writeCache(cacheKey, transMap);
      } else {
        console.log("[YTDual] cache=" + Object.keys(transMap).length);
      }

      // 合成双行
      let data;
      try { data = JSON.parse(body); } catch(e) { safeReturn(body); return; }

      let hit = 0;
      for (const e of (data.events || [])) {
        if (!e.segs) continue;
        const orig = e.segs.map(s => s.utf8||"").join("").replace(/\n/g," ").trim();
        if (!orig) continue;
        const trans = transMap[String(e.tStartMs)] || fuzzyGet(transMap, e.tStartMs);
        if (!trans || trans === orig) continue;
        e.segs = [{ utf8: makeLine(orig, trans, LAYOUT) }];
        hit++;
      }
      console.log("[YTDual] hit=" + hit + " ✅");

      safeReturn(JSON.stringify(data));

    } catch(e) {
      console.log("[YTDual] ERR: " + e.message);
      safeReturn(body);
    }
  })();
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
  console.log("[YTDual] " + chunks.length + " batches");
  for (let ci = 0; ci < chunks.length; ci++) {
    try {
      const t = await googleTranslate(chunks[ci].map(e=>e.text).join(SEP), tl);
      t.split(/❖/).forEach((s,i) => {
        const c = s.trim();
        if (c && chunks[ci][i]) map[chunks[ci][i].key] = c;
      });
      console.log("[YTDual] batch" + (ci+1) + " ok");
    } catch(e) { console.log("[YTDual] batch" + (ci+1) + " fail: " + e.message); }
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
