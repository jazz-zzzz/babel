/**
 * @file url.js
 * @description 应用链接与接口 URL 常量定义模块。定义本地 CacheStorage 所需的伪 HTTP URL 作为拦截 Key，以及 GitHub 仓库相关的外部文档链接。
 */

import { APP_LCNAME } from "./app";

// --- 缓存拦截用的虚拟伪 URL，用于本地 Cache 系统的键名区分 ---
export const URL_CACHE_TRAN = `https://${APP_LCNAME}/translate`; // 网页正文翻译结果缓存 Key
export const URL_CACHE_SUBTITLE = `https://${APP_LCNAME}/subtitle`; // 字幕翻译结果缓存 Key
export const URL_CACHE_DELANG = `https://${APP_LCNAME}/detectlang`; // 语言判定结果缓存 Key
export const URL_CACHE_BINGDICT = `https://${APP_LCNAME}/bingdict`; // 必应词典查询结果缓存 Key

// --- 外部相关的开源仓库及文档地址 ---
export const URL_BABEL_WORKER = "https://github.com/"; // CF Worker 同步服务项目地址
export const URL_BABEL_PROXY = "https://github.com/"; // 翻译 API 跨域中转代理项目地址
export const URL_BABEL_RULES = "https://github.com/"; // 网页翻译适配规则项目地址
export const URL_BABEL_RULES_NEW_ISSUE = "https://github.com//issues/new"; // 反馈网页翻译规则故障的 Issue 链接
export const URL_RAW_PREFIX =
  "https://raw.githubusercontent.com/jazz-zzzz/babel/master"; // 访问 GitHub 原始文件的 URL 前缀 (用于拉取最新的 README 等)
