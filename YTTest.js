/*
 * YouTube 字幕拦截测试脚本
 * 目的：只验证 Loon 有没有成功拦截到字幕请求
 * 如果触发成功，Loon 日志里会出现 [YTTest] 开头的内容
 */

const url  = $request.url;
const body = $response.body;

console.log("[YTTest] ========== 触发成功 ==========");
console.log("[YTTest] URL: " + url.slice(0, 120));
console.log("[YTTest] Body 长度: " + (body ? body.length : 0));
console.log("[YTTest] Body 前80字符: " + (body ? body.slice(0, 80) : "空"));

// 不修改任何内容，直接放行
$done({});
