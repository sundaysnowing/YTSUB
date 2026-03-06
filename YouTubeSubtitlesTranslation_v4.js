/*
 * YouTube 双字幕 v5.3
 *
 * 不改请求格式，响应阶段：
 * 1. 收到 srv3 后，用同样的 URL 但换成 json3 重新请求一份
 * 2. 翻译 json3，合成双行
 * 3. 把合成好的 json3 替换 srv3 返回，同时修正响应头
 *
 * 关键：$done 里同时传 body 和正确的 headers
 */

const SEP = "\n❖\n", CHUNK_MAX = 3500;

const url  = $request.url;
const body = $response.body;

console.log("[YTDual] RESP len=" + (body||"").length + " head=" + (body||"").slice(0,15));

function done(b) {
  // 必须同时修正这两个响应头，否则 App 解析失败
  const h = {};
  for (const k of Object.keys($response.headers || {})) {
    const kl = k.toLowerCase();
    if (kl === "content-encoding" || kl === "content-length") continue;
    h[k] = $response.headers[k];
  }
  h["content-type"] = "application/json; charset=UTF-8";
  $done({ body: b, headers: h });
}

function passthrough() {
  $done({ body: body });
}

if (!body || body.length < 10) { passthrough(); return; }

const ARGS        = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const TARGET_LANG = ARGS.tl   || "zh-Hans";
const LAYOUT      = ARGS.line || "f";

const params  = parseURLParams(url);
const videoId = params.v || params.videoId || "";
if (!videoId) { passthrough(); return; }

const fmt = detectFormat(body);
console.log("[YTDual] fmt=" + fmt + " videoId=" + videoId);

(async () => {
  try {
    const cacheKey     = "YTDual53_" + videoId + "_" + TARGET_LANG;
    const cacheKeyJ3   = "YTDual53_" + videoId + "_j3";
    let transMap  = readCache(cacheKey);
    let j3body    = readCache(cacheKeyJ3);

    if (!transMap || !j3body) {
      // 构造 json3 URL（把当前 URL 的 fmt 改成 json3）
      let j3url = url.replace(/([?&])(fmt|format)=([^&]*)/g, "$1fmt=json3");
      if (!/[?&]fmt=/.test(j3url)) j3url += "&fmt=json3";
      console.log("[YTDual] 抓 json3: " + j3url.slice(0,120));

      try {
        j3body = await httpGet(j3url);
        console.log("[YTDual] json3 len=" + j3body.length + " head=" + j3body.slice(0,15));
      } catch(e) {
        console.log("[YTDual] json3 fetch fail: " + e.message);
        passthrough(); return;
      }

      // 验证是合法 json3
      if (!j3body.trimStart().startsWith("{")) {
        console.log("[YTDual] 返回不是 json3: " + j3body.slice(0,50));
        passthrough(); return;
      }

      // 提取字幕条目
      const entries = [];
      try {
        const data = JSON.parse(j3body);
        for (const e of (data.events||[])) {
          if (!e.segs) continue;
          const text = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
          if (text) entries.push({ key: String(e.tStartMs||0), text });
        }
      } catch(e) { console.log("[YTDual] json3 parse err: " + e.message); passthrough(); return; }

      console.log("[YTDual] entries=" + entries.length);
      if (!entries.length) { passthrough(); return; }

      transMap = await translateAll(entries, TARGET_LANG);
      console.log("[YTDual] translated=" + Object.keys(transMap).length);

      if (Object.keys(transMap).length > 0) {
        writeCache(cacheKey, transMap);
        writeCache(cacheKeyJ3, j3body);
      }
    } else {
      console.log("[YTDual] cache hit trans=" + Object.keys(transMap).length);
    }

    // 合成双行 json3
    let data;
    try { data = JSON.parse(j3body); } catch(e) { passthrough(); return; }

    let hit = 0;
    for (const e of (data.events||[])) {
      if (!e.segs) continue;
      const orig = e.segs.map(s=>s.utf8||"").join("").replace(/\n/g," ").trim();
      if (!orig) continue;
      const trans = transMap[String(e.tStartMs)] || fuzzyGet(transMap, e.tStartMs);
      if (!trans || trans === orig) continue;
      e.segs = [{ utf8: makeLine(orig, trans, LAYOUT) }];
      hit++;
    }
    console.log("[YTDual] hit=" + hit + " ✅");
    done(JSON.stringify(data));

  } catch(e) {
    console.log("[YTDual] ERR: " + e.message);
    passthrough();
  }
})();

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    $httpClient.get({ url, headers:{"User-Agent":"com.google.ios.youtube/19.45.4 (iPhone; iOS 17.0)"} },
      (err,_r,b) => { clearTimeout(timer); if(err) reject(new Error(String(err))); else resolve(b); });
  });
}

function detectFormat(body) {
  const t = (body||"").trimStart();
  if (t.startsWith("{"))  return "json3";
  if (t.startsWith("WEB")) return "webvtt";
  if (t.startsWith("<"))  return "xml";
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
