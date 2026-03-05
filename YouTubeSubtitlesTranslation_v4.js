/*

- YouTube 双字幕 - 全文上下文翻译版
- 基于 Neurogram/Dualsub.js 改进
- 
- 核心改进：解决原版上下文割裂问题
- 原版：每次拦截只能看到当前几句 → 每批80句单独翻译 → 句间语义割裂
- 本版：首次拦截时主动抓取视频全量字幕 → 整段按语义分块翻译 → 结果缓存
- ```
      后续请求直接从缓存取译文合成双行 → 翻译连贯，且无额外延迟
  ```
- 
- 与原版兼容：
- - 保留 $persistentStore 设置结构（type/sl/tl/line）
- - 保留 YouTube tlang 官方翻译模式（type=Official）
- - 新增 type=Google_Full（全文预取模式，推荐）
    */

const url     = $request.url;
const headers = $request.headers;

// ── 默认配置（与原版结构兼容）────────────────────────────────────────────────
const DEFAULT = {
type: “Google_Full”, // Google_Full（推荐）| Official（YouTube官方翻译）| Disable
sl:   “auto”,        // 源语言
tl:   “zh-Hans”,     // 目标语言
line: “s”,           // s=原文在上译文在下  f=译文在上原文在下  tl=仅译文
};

// ── 读取持久化设置 ────────────────────────────────────────────────────────────
let allSettings = $persistentStore.read(“YTDualSubs_settings”);
allSettings = allSettings ? JSON.parse(allSettings) : {};
const setting = Object.assign({}, DEFAULT, allSettings.YouTube || {});

// 禁用时直接放行
if (setting.type === “Disable”) { $done({}); return; }

// 只处理 YouTube timedtext 请求
if (!url.match(/youtube.com/api/timedtext/)) { $done({}); return; }

const body = $response.body;
if (!body || body.length < 20) { $done({}); return; }

// ── 解析视频 ID ───────────────────────────────────────────────────────────────
const params  = parseURLParams(url);
const videoId = params.v || params.videoId || “”;
if (!videoId) { $done({}); return; }

// ── 判断字幕格式 ──────────────────────────────────────────────────────────────
const fmt = detectFormat(body, url);
if (fmt === “unknown”) { $done({}); return; }

// ── 官方翻译模式（复用原版逻辑，用 YouTube tlang 接口）───────────────────────
if (setting.type === “Official”) {
const tl = normalizeYTLang(setting.tl);
// 如果当前响应已经是目标语言，直接放行
if (url.match(new RegExp(`lang=${setting.tl}`)) || url.match(/&tlang=/)) {
$done({});
return;
}
const t_url = `${url}&tlang=${tl}`;
$httpClient.get({ url: t_url, headers }, function(err, _resp, data) {
if (err || !data) { $done({}); return; }
if (setting.line === “sl”) { $done({ body: data }); return; }
$done({ body: mergeXMLBodies(body, data, setting.line) });
});
return;
}

// ── Google_Full 模式（全文预取，上下文连贯）──────────────────────────────────
(async () => {
try {
const cacheKey = `YTCache_${videoId}_${setting.tl}`;
let transMap = readCache(cacheKey);

```
if (!transMap) {
  // ① 首次：抓取全量字幕 → 整体翻译 → 缓存
  console.log(`[YTDual] 首次加载 ${videoId}，预取全量字幕...`);
  const fullUrl  = buildFullSubUrl(url, params);
  const fullBody = await httpGet(fullUrl);
  const entries  = extractEntries(fullBody);

  if (!entries.length) {
    console.log("[YTDual] 未能解析字幕，降级实时翻译");
    const result = await realtimeFallback(body, fmt, setting);
    $done({ body: result });
    return;
  }

  console.log(`[YTDual] 解析到 ${entries.length} 条字幕，开始翻译...`);
  transMap = await translateAll(entries, setting);
  if (Object.keys(transMap).length > 0) {
    writeCache(cacheKey, transMap);
    console.log(`[YTDual] 翻译完成，缓存 ${Object.keys(transMap).length} 条`);
  }
} else {
  console.log(`[YTDual] 命中缓存 (${Object.keys(transMap).length} 条)`);
}

// ② 用缓存合成当前响应的双行字幕
$done({ body: composeDual(body, fmt, transMap, setting) });
```

} catch (e) {
console.log(”[YTDual] 异常: “ + (e.message || e));
$done({});
}
})();

// ══════════════════════════════════════════════════════════════════════════════
//  构造全量字幕 URL（去掉分段限制参数）
// ══════════════════════════════════════════════════════════════════════════════
function buildFullSubUrl(origUrl, params) {
// 移除分段、客户端信息等无关参数，保留鉴权参数
const strip = new Set([
“seek_to_segment_start”,“seg”,“xorb”,“xobt”,“xovt”,“asr_langs”,
“cbr”,“cbrver”,“c”,“cver”,“cplayer”,“cos”,“cosver”,“cplatform”,“cpn”
]);
const base  = “https://www.youtube.com/api/timedtext”;
const parts = [];
for (const [k, v] of Object.entries(params)) {
if (!strip.has(k)) parts.push(`${k}=${encodeURIComponent(v)}`);
}
// 强制 json3 格式，保证返回完整结构化数据
const fmtIdx = parts.findIndex(p => p.startsWith(“fmt=”));
if (fmtIdx < 0) parts.push(“fmt=json3”);
else parts[fmtIdx] = “fmt=json3”;

return base + “?” + parts.join(”&”);
}

// ══════════════════════════════════════════════════════════════════════════════
//  提取字幕条目 [{tStartMs, text}, …]（支持 json3 / webvtt / xml）
// ══════════════════════════════════════════════════════════════════════════════
function extractEntries(body) {
const entries = [];
const t = (body || “”).trimStart();

if (t.startsWith(”{”)) {
try {
const data = JSON.parse(body);
for (const e of (data.events || [])) {
if (!e.segs) continue;
const text = e.segs.map(s => s.utf8 || “”).join(””).replace(/\n/g, “ “).trim();
if (text) entries.push({ key: String(e.tStartMs || 0), text });
}
} catch (_) {}

} else if (t.startsWith(“WEBVTT”)) {
const lines = body.split(”\n”);
for (let i = 0; i < lines.length; i++) {
if (!lines[i].includes(”–>”)) continue;
const ms = vttToMs(lines[i].split(”–>”)[0].trim());
const textParts = [];
let j = i + 1;
while (j < lines.length && lines[j].trim()) {
textParts.push(lines[j].replace(/<[^>]+>/g, “”).trim());
j++;
}
const text = textParts.join(” “).trim();
if (text) entries.push({ key: String(ms), text });
}

} else if (t.startsWith(”<”)) {
const re = /<text\b[^>]*\bstart=”([^”]*)”[^>]*>([\s\S]*?)</text>/gi;
let m;
while ((m = re.exec(body)) !== null) {
const ms   = Math.round(parseFloat(m[1]) * 1000);
const text = decodeHTML(m[2]).replace(/\n/g, “ “).trim();
if (text) entries.push({ key: String(ms), text });
}
}

return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
//  整体翻译：按字符数分块，块内保持上下文连贯
//  关键改进：使用段落式合并翻译，而不是逐句翻译
// ══════════════════════════════════════════════════════════════════════════════
const SEP       = “\n❖\n”;   // 块内分隔符（字幕中极罕见）
const CHUNK_MAX = 4000;       // Google Translate POST 安全上限

async function translateAll(entries, setting) {
const map    = {};
const chunks = [];
let   cur    = [], curLen = 0;

// 按字符数切块，块内句子一起翻译（Google 能看到完整上下文）
for (const e of entries) {
const len = e.text.length + SEP.length;
if (curLen + len > CHUNK_MAX && cur.length) {
chunks.push(cur);
cur = []; curLen = 0;
}
cur.push(e);
curLen += len;
}
if (cur.length) chunks.push(cur);

console.log(`[YTDual] ${chunks.length} 个翻译批次`);

for (let ci = 0; ci < chunks.length; ci++) {
const chunk    = chunks[ci];
const combined = chunk.map(e => e.text).join(SEP);

```
try {
  const translated = await googleTranslate(combined, setting.sl, setting.tl);
  // 按分隔符还原各句
  const parts = translated.split(/❖/);
  chunk.forEach((e, i) => {
    const t = (parts[i] || "").trim();
    if (t) map[e.key] = t;
  });
} catch (err) {
  console.log(`[YTDual] 批次 ${ci + 1} 失败: ${err.message}`);
  // 跳过本批，不影响其他批次
}
```

}

return map;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Google Translate API（POST 方式，dj=1 返回 JSON，稳定可靠）
// ══════════════════════════════════════════════════════════════════════════════
function googleTranslate(text, sl, tl) {
return new Promise((resolve, reject) => {
const timer = setTimeout(() => reject(new Error(“超时”)), 12000);
$httpClient.post({
url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${encodeURIComponent(tl)}&dt=t&dj=1`,
headers: {
“Content-Type”: “application/x-www-form-urlencoded”,
“User-Agent”: “GoogleTranslate/6.29.59279 (iPhone; iOS 15.4; en; iPhone14,2)”,
“Referer”: “https://translate.google.com/”,
},
body: “q=” + encodeURIComponent(text),
}, (err, _r, body) => {
clearTimeout(timer);
if (err) { reject(new Error(String(err))); return; }
try {
const data = JSON.parse(body);
if (Array.isArray(data.sentences)) {
resolve(data.sentences.map(s => s.trans || “”).join(””).trim());
} else {
reject(new Error(“响应格式异常”));
}
} catch (e) { reject(e); }
});
});
}

// ══════════════════════════════════════════════════════════════════════════════
//  合成双行字幕（从缓存 map 取译文，写入当前响应）
// ══════════════════════════════════════════════════════════════════════════════
function composeDual(body, fmt, map, setting) {
try {
if (fmt === “json3”)  return composeDualJSON3(body, map, setting);
if (fmt === “webvtt”) return composeDualVTT(body, map, setting);
if (fmt === “xml”)    return composeDualXML(body, map, setting);
} catch (e) { console.log(”[YTDual] 合成出错: “ + e.message); }
return body;
}

function composeDualJSON3(body, map, setting) {
const data = JSON.parse(body);
for (const e of (data.events || [])) {
if (!e.segs) continue;
const orig  = e.segs.map(s => s.utf8 || “”).join(””).replace(/\n/g, “ “).trim();
if (!orig) continue;
const trans = map[String(e.tStartMs)] || fuzzyGet(map, e.tStartMs);
if (!trans || trans === orig) continue;
e.segs = [{ utf8: makeLine(orig, trans, setting.line) }];
}
return JSON.stringify(data);
}

function composeDualVTT(body, map, setting) {
const lines = body.split(”\n”), out = [];
let i = 0;
while (i < lines.length) {
out.push(lines[i]);
if (lines[i].includes(”–>”)) {
const ms    = vttToMs(lines[i].split(”–>”)[0].trim());
const texts = [];
i++;
while (i < lines.length && lines[i].trim()) {
texts.push(lines[i].replace(/<[^>]+>/g, “”).trim());
i++;
}
const orig  = texts.join(” “).trim();
const trans = map[String(ms)] || fuzzyGet(map, ms);
out.push(trans && trans !== orig ? makeLine(orig, trans, setting.line) : orig);
continue;
}
i++;
}
return out.join(”\n”);
}

function composeDualXML(body, map, setting) {
return body.replace(/<text\b([^>]*)>([\s\S]*?)</text>/gi, (full, attrs, content) => {
const sm = attrs.match(/\bstart=”([^”]*)”/);
if (!sm) return full;
const ms    = Math.round(parseFloat(sm[1]) * 1000);
const orig  = decodeHTML(content).replace(/\n/g, “ “).trim();
const trans = map[String(ms)] || fuzzyGet(map, ms);
if (!trans || trans === orig) return full;
return `<text${attrs}>${encodeHTML(makeLine(orig, trans, setting.line))}</text>`;
});
}

// ── 双行排列 ──────────────────────────────────────────────────────────────────
function makeLine(orig, trans, line) {
if (line === “f”  || line === “translate_top”)  return trans + “\n” + orig;
if (line === “tl” || line === “translate_only”) return trans;
return orig + “\n” + trans; // 默认：原文在上
}

// ══════════════════════════════════════════════════════════════════════════════
//  原版 XML 双行合并（Official 模式复用）
// ══════════════════════════════════════════════════════════════════════════════
function mergeXMLBodies(s_body, t_body, line) {
s_body = s_body.replace(/</?s[^>]*>/g, “”);
t_body = t_body.replace(/</?s[^>]*>/g, “”);
const timeline = s_body.match(/<p t=”\d+” d=”\d+”[^>]+>/g) || [];
for (const tl of timeline) {
const patt = new RegExp(`${tl}([^<]+)<\\/p>`);
if (s_body.match(patt) && t_body.match(patt)) {
if (line === “s”) s_body = s_body.replace(patt, `${tl}$1\n${t_body.match(patt)[1]}</p>`);
if (line === “f”) s_body = s_body.replace(patt, `${tl}${t_body.match(patt)[1]}\n$1</p>`);
}
}
return s_body;
}

// ══════════════════════════════════════════════════════════════════════════════
//  降级：仅翻译当前这批字幕（全文预取失败时）
// ══════════════════════════════════════════════════════════════════════════════
async function realtimeFallback(body, fmt, setting) {
const entries = extractEntries(body);
if (!entries.length) return body;
const map = await translateAll(entries, setting);
return composeDual(body, fmt, map, setting);
}

// ══════════════════════════════════════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════════════════════════════════════

// 模糊时间匹配（±300ms 容差）
function fuzzyGet(map, tMs) {
const t = Number(tMs);
for (const k of Object.keys(map)) {
if (Math.abs(Number(k) - t) <= 300) return map[k];
}
return null;
}

function httpGet(url) {
return new Promise((resolve, reject) => {
const timer = setTimeout(() => reject(new Error(“请求超时”)), 12000);
$httpClient.get({
url,
headers: { “User-Agent”: “com.google.ios.youtube/19.45.4 (iPhone; iOS 17.0)” },
}, (err, _r, body) => {
clearTimeout(timer);
if (err) reject(new Error(String(err)));
else resolve(body);
});
});
}

function detectFormat(body, url) {
const t = (body || “”).trimStart();
if (t.startsWith(”{”))      return “json3”;
if (t.startsWith(“WEBVTT”)) return “webvtt”;
if (t.startsWith(”<”))      return “xml”;
if (url.includes(“fmt=vtt”)) return “webvtt”;
if (url.includes(“fmt=srv”) || url.includes(“fmt=ttml”)) return “xml”;
return “unknown”;
}

function normalizeYTLang(tl) {
return tl === “zh-CN” ? “zh-Hans” : tl === “zh-TW” ? “zh-Hant” : tl;
}

function vttToMs(s) {
const p = s.trim().split(”:”);
if (p.length === 3) return Math.round((+p[0]*3600 + +p[1]*60 + parseFloat(p[2]))*1000);
if (p.length === 2) return Math.round((+p[0]*60 + parseFloat(p[1]))*1000);
return 0;
}

function parseURLParams(url) {
const obj = {}, qi = url.indexOf(”?”);
if (qi < 0) return obj;
url.slice(qi+1).split(”&”).forEach(p => {
const eq = p.indexOf(”=”);
if (eq < 0) return;
try { obj[decodeURIComponent(p.slice(0,eq))] = decodeURIComponent(p.slice(eq+1)); } catch(_){}
});
return obj;
}

function readCache(key) {
try { const r = $persistentStore.read(key); return r ? JSON.parse(r) : null; }
catch(_) { return null; }
}

function writeCache(key, obj) {
try { $persistentStore.write(JSON.stringify(obj), key); } catch(_) {}
}

function decodeHTML(s) {
return (s||””).replace(/&/g,”&”).replace(/</g,”<”).replace(/>/g,”>”)
.replace(/"/g,’”’).replace(/'/g,”’”).replace(/ /g,” “)
.replace(/&#(\d+);/g,(*,c)=>String.fromCharCode(+c))
.replace(/&#x([0-9a-f]+);/gi,(*,h)=>String.fromCharCode(parseInt(h,16)));
}

function encodeHTML(s) {
return (s||””).replace(/&/g,”&”).replace(/</g,”<”).replace(/>/g,”>”).replace(/”/g,”"”);
}
