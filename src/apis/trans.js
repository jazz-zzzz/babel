import queryString from "query-string";
import {
  OPT_TRANS_GOOGLE,
  OPT_TRANS_GOOGLE_2,
  OPT_TRANS_MICROSOFT,
  OPT_TRANS_AZUREAI,
  OPT_TRANS_DEEPL,
  OPT_TRANS_DEEPLFREE,
  OPT_TRANS_DEEPLX,
  OPT_TRANS_DEEPSEEK,
  OPT_TRANS_SILICONFLOW,
  OPT_TRANS_XIAOMIMIMO,
  OPT_TRANS_ALIYUNBAILIAN,
  OPT_TRANS_CEREBRAS,
  OPT_TRANS_ZAI,
  OPT_TRANS_EPHONEAI,
  OPT_TRANS_BAIDU,
  OPT_TRANS_TENCENT,
  OPT_TRANS_VOLCENGINE,
  OPT_TRANS_OPENAI,
  OPT_TRANS_GEMINI,
  OPT_TRANS_GEMINI_2,
  OPT_TRANS_CLAUDE,
  OPT_TRANS_CLOUDFLAREAI,
  OPT_TRANS_OLLAMA,
  OPT_TRANS_OPENROUTER,
  OPT_TRANS_CUSTOMIZE,
  API_SPE_TYPES,
  INPUT_PLACE_FROM,
  INPUT_PLACE_TO,
  INPUT_PLACE_TEXT,
  INPUT_PLACE_KEY,
  INPUT_PLACE_MODEL,
  DEFAULT_USER_AGENT,
  defaultSystemPrompt,
  defaultSubtitlePrompt,
  defaultNobatchPrompt,
  defaultNobatchUserPrompt,
  INPUT_PLACE_TONE,
  INPUT_PLACE_TITLE,
  INPUT_PLACE_DESCRIPTION,
  INPUT_PLACE_TO_LANG,
  INPUT_PLACE_FROM_LANG,
  INPUT_PLACE_GLOSSARY,
  defaultSystemPromptXml,
  defaultSystemPromptLines,
  INPUT_PLACE_SUMMARY,
  THINKING_PARAM_MAP,
} from "../config";
import { msAuth } from "../libs/auth";
import { genDeeplFree } from "./deepl";
import { genBaidu } from "./baidu";
import { interpreter } from "../libs/interpreter";
import {
  parseJsonObj,
  extractJson,
  stripMarkdownCodeBlock,
  parseAITerms,
  decodeHTMLEntities,
} from "../libs/utils";
import {
  parseStreamingSegments,
  createStreamingJsonParser,
  createRealtimeStreamParser,
  detectStreamFormat,
  getStreamDelta,
} from "../libs/stream";
import { babelLog } from "../libs/log";
import { fetchData, fetchStream } from "../libs/fetch";
import { getMsgHistory } from "./history";
import { parseBilingualVtt } from "../subtitle/vtt";
import { getDocInfo } from "../libs/docInfo";
import { parseStrictSubtitleChunkResult } from "./subtitleBatch";

const keyMap = new Map();
const urlMap = new Map();

// 轮询key/url
// 轮询 Key / URL 负载均衡。
// 用于在配置了多个 API 密钥或自定义 URL 端点时，分摊频率并降低单 Key 被限流限额的风险。
const keyPick = (apiSlug, key = "", cacheMap) => {
  const keys = key
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    return "";
  }

  // 从轮询缓存 cacheMap 中提取上一次使用的 Index，计算本次轮询的 Index 并写回缓存
  const preIndex = cacheMap.get(apiSlug) ?? -1;
  const curIndex = (preIndex + 1) % keys.length;
  cacheMap.set(apiSlug, curIndex);

  return keys[curIndex];
};

/**
 * 依据配置参数和当前页面元数据生成大模型 Prompt 系统指示。
 */
const genSystemPrompt = ({
  systemPrompt,
  tone,
  from,
  to,
  fromLang,
  toLang,
  texts,
  docInfo: { title = "", description = "", summary = "" } = {},
}) =>
  systemPrompt
    .replaceAll(INPUT_PLACE_TITLE, title)
    .replaceAll(INPUT_PLACE_DESCRIPTION, description)
    .replaceAll(INPUT_PLACE_SUMMARY, summary)
    .replaceAll(INPUT_PLACE_TONE, tone)
    .replaceAll(INPUT_PLACE_FROM, from)
    .replaceAll(INPUT_PLACE_TO, to)
    .replaceAll(INPUT_PLACE_FROM_LANG, fromLang)
    .replaceAll(INPUT_PLACE_TO_LANG, toLang)
    .replaceAll(INPUT_PLACE_TEXT, texts[0]);

const genUserPrompt = ({
  nobatchUserPrompt,
  useBatchFetch,
  tone,
  glossary = {}, // 规则中的AI专业术语
  aiTerms = "", // 接口中的AI专业术语
  from,
  to,
  fromLang,
  toLang,
  texts,
  contextBefore = [],
  contextAfter = [],
  docInfo: { title = "", description = "", summary = "" } = {},
}) => {
  if (useBatchFetch) {
    const promptObj = {
      targetLanguage: toLang,
      segments: texts.map((text, i) => ({ id: i, text })),
    };

    if (contextBefore.length) {
      promptObj.contextBefore = contextBefore;
    }
    if (contextAfter.length) {
      promptObj.contextAfter = contextAfter;
    }

    title && (promptObj.title = title);
    description && (promptObj.description = description);

    // 合并规则与接口中的AI专业术语
    if (aiTerms) {
      const aiGlossary = parseAITerms(aiTerms);
      glossary = { ...glossary, ...aiGlossary };
    }

    Object.keys(glossary).length !== 0 && (promptObj.glossary = glossary);
    tone && (promptObj.tone = tone);

    return JSON.stringify(promptObj);
  }

  return nobatchUserPrompt
    .replaceAll(INPUT_PLACE_TITLE, title)
    .replaceAll(INPUT_PLACE_DESCRIPTION, description)
    .replaceAll(INPUT_PLACE_SUMMARY, summary)
    .replaceAll(INPUT_PLACE_TONE, tone)
    .replaceAll(INPUT_PLACE_FROM, from)
    .replaceAll(INPUT_PLACE_TO, to)
    .replaceAll(INPUT_PLACE_FROM_LANG, fromLang)
    .replaceAll(INPUT_PLACE_TO_LANG, toLang)
    .replaceAll(INPUT_PLACE_TEXT, texts[0]);
};

const genSubtitlePrompt = ({
  subtitlePrompt,
  tone,
  from,
  to,
  fromLang,
  toLang,
  docInfo: { title = "", description = "", summary = "" } = {},
  aiTerms = "",
}) => {
  const aiGlossary = parseAITerms(aiTerms);
  const glossaryStr = Object.entries(aiGlossary)
    .map(([term, definition]) => `- ${term}: ${definition}`)
    .join("\n");
  return subtitlePrompt
    .replaceAll(INPUT_PLACE_TITLE, title)
    .replaceAll(INPUT_PLACE_DESCRIPTION, description)
    .replaceAll(INPUT_PLACE_SUMMARY, summary)
    .replaceAll(INPUT_PLACE_TONE, tone)
    .replaceAll(INPUT_PLACE_GLOSSARY, glossaryStr)
    .replaceAll(INPUT_PLACE_FROM, from)
    .replaceAll(INPUT_PLACE_TO, to)
    .replaceAll(INPUT_PLACE_FROM_LANG, fromLang)
    .replaceAll(INPUT_PLACE_TO_LANG, toLang);
};

const normalizeSubtitleContext = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);

const buildSubtitleUserPrompt = ({
  formattedEvents,
  prevContext = "",
  nextContext = "",
}) => {
  const mainInput = JSON.stringify(formattedEvents);
  const prev = normalizeSubtitleContext(prevContext);
  const next = normalizeSubtitleContext(nextContext);
  if (!prev && !next) return mainInput;
  const sections = [];
  if (prev) {
    sections.push(
      `[Previous context (read-only, do NOT segment)]\n${JSON.stringify(prev)}`
    );
  }
  sections.push(`[Main input]\n${mainInput}`);
  if (next) {
    sections.push(
      `[Next context (read-only, do NOT segment)]\n${JSON.stringify(next)}`
    );
  }
  return sections.join("\n\n");
};

/**
 * 强健的大模型翻译结果解析器 (AI Response Robust Parser)。
 * 完美解决大模型在翻译时常混杂的 Markdown、未闭合 JSON、XML、数字列表及无规换行文本的纠错与规避问题。
 * @param {string} raw 大模型返回的原始字符串内容
 * @param {boolean} useBatchFetch 是否为批量翻译模式
 * @returns {Array<[string, string]>} 解析后的双元组列表 [译文, 源语言检测结果]
 */
const parseAIRes = (raw, useBatchFetch = true) => {
  if (!raw) {
    return [];
  }

  // 纯覆盖单段模式，直接包装返回
  if (!useBatchFetch) {
    return [[raw]];
  }

  babelLog("INFO", `[BATCH_PARSE] parseAIRes called, raw length: ${raw.length}`);

  // 剥离 Markdown 常用的 ```json...``` 代码块包裹
  let content = stripMarkdownCodeBlock(raw).trim();

  // 1. 按约定格式 ["id":N,"text":"..."] 逐对象提取，不依赖 JSON.parse
  //    每个对象独立匹配——一个坏了不影响其他，且 id 直接索引无需排序
  const OBJ_RE = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  const indexed = [];
  let match;
  while ((match = OBJ_RE.exec(content)) !== null) {
    const id = parseInt(match[1], 10);
    const text = decodeHTMLEntities(
      match[2].replace(/\\(.)/g, "$1") // 还原转义字符 \" → " , \\ → \ 等
    );
    if (Number.isInteger(id) && text) {
      indexed[id] = [text, ""];
    }
  }
  if (indexed.length > 0) {
    // 稀疏转稠密：未收到的 id 填空
    for (let i = 0; i < indexed.length; i++) {
      if (!indexed[i]) indexed[i] = ["", ""];
    }
    babelLog(
      "INFO",
      `[BATCH_PARSE] regex matched ${indexed.filter((e) => e[0]).length} objects, result length ${indexed.length}`
    );
    return indexed;
  }

  // 2. 降级：尝试标准 JSON 解析（处理非 ["id", "text"] 格式的回包）
  try {
    const start = content.search(/(\{|\[)/);
    const end = content.lastIndexOf(content.includes("}") ? "}" : "]");

    if (start > -1 && end > -1) {
      let jsonStr = content.substring(start, end + 1);
      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e1) {
        // LLM 回复常见 JSON 笔误修复
        const e1Pos = parseInt((e1.message.match(/position (\d+)/) || [])[1]) || 0;
        let fixed = jsonStr
          .replace(/"id:(\d+)/g, '"id":$1')
          .replace(/,(\s*[}\]])/g, "$1");
        // 如果错误位置是一个裸引号（值中未转义的 "），尝试转义它
        if (e1Pos > 0 && jsonStr[e1Pos] === '"') {
          const before = jsonStr.slice(0, e1Pos);
          // 在 JSON 字符串值内部（偶数个反斜杠之后）的引号需要转义
          const escCount = (before.match(/(^|[^\\])(\\\\)*$/)?.[0]?.match(/\\/g)?.length ?? 0);
          if (escCount % 2 === 0) {
            fixed = jsonStr.slice(0, e1Pos) + '\\' + jsonStr.slice(e1Pos);
          }
        }
        try {
          parsed = JSON.parse(fixed);
        } catch (e2) {
          const e2Pos = parseInt((e2.message.match(/position (\d+)/) || [])[1]) || 0;
          babelLog(
            "WARN",
            `parseAIRes JSON parse failed pos=${e2Pos}: ${fixed.slice(Math.max(0, e2Pos - 80), e2Pos + 80)}`
          );
          throw new Error("JSON parse failed even after fixup");
        }
      }

      const list = Array.isArray(parsed)
        ? parsed
        : parsed.translations || (parsed.result ? [parsed.result] : [parsed]);

      // 过滤掉 LLM 回复中夹杂的非翻译条目（如开场白、解释文字等），
      // 只保留有 text 字段的真正翻译结果。
      // 按 id 直接索引：结果数组的 position n = segment id n 的翻译，
      // 不依赖排序或补洞，id 严格对应。
      const valid = list.filter(
        (item) => item && typeof item.text === "string"
      );
      if (valid.length > 0) {
        const hasId = valid.some(
          (item) => typeof item.id === "number"
        );
        if (hasId) {
          const indexed = [];
          for (const item of valid) {
            indexed[item.id] = [
              decodeHTMLEntities(item.text),
              String(item.sourceLanguage || ""),
            ];
          }
          // 稀疏转稠密：未收到的 id 填空翻译
          for (let i = 0; i < indexed.length; i++) {
            if (!indexed[i]) indexed[i] = ["", ""];
          }
          return indexed;
        }
        return valid.map((item) => [
          decodeHTMLEntities(item.text),
          String(item.sourceLanguage || ""),
        ]);
      }
    }
  } catch (e) {
    // 忽略异常，平滑降级到 XML 尝试
  }

  // 2. 尝试以 XML 标签格式解析 (如 <t>...</t> 或 <seg>...</seg> 块)
  const xmlTagPattern = /<(t|item|seg)\b/i;
  if (xmlTagPattern.test(content)) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, "text/html");
      const elements = doc.querySelectorAll("t, item, seg");

      if (elements.length > 0) {
        return Array.from(elements).map((el) => [
          el.innerHTML.trim(),
          el.getAttribute("sourceLanguage") || "",
        ]);
      }
    } catch (e) {
      // 忽略，降级到纯文本多级备用
    }
  }

  // 3. 兜底策略：纯文本单行/带序号和管道符按行切割解析 (例如 "1 | 译文" 格式)
  return content.split("\n").map((line) => {
    const pipeMatch = line.match(/^\d+\s*\|\s*(.*)/);
    if (pipeMatch) {
      return [decodeHTMLEntities(pipeMatch[1].trim()), ""];
    }

    const text = decodeHTMLEntities(line.replace(/<br\s*\/?>/gi, "\n").trim());
    return [text, ""];
  });
};

/**
 * 依据时间差计算字幕中发生的句子停顿断句等级。
 */
const getPauseLevel = (gapMs) => {
  if (!Number.isFinite(gapMs) || gapMs <= 300) return 0;
  if (gapMs <= 600) return 1;
  if (gapMs <= 1200) return 2;
  return 3;
};

const formatIndexSubtitleEvents = (events) =>
  events.map((e, i) => {
    const item = { id: i, text: e.text };
    if (i > 0) {
      const p = getPauseLevel(e.start - events[i - 1].end);
      if (p) item.p = p;
    }
    return item;
  });

const usesIndexSubtitleInput = (prompt = "") => {
  if (/\{\s*["']?s["']?\s*:/.test(prompt) && /\bid\b/i.test(prompt))
    return true;
  if (/WEBVTT|MM:SS\.mmm|-->/i.test(prompt)) return false;
  return false;
};

const geminiText = (parts) =>
  Array.isArray(parts)
    ? parts
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join("")
    : "";

const parseIndexSubtitleRes = (raw, events) => {
  const buildResult = (data) => {
    if (!Array.isArray(data) || !data.length) return null;
    const result = [];
    for (const seg of data) {
      const s = Number(seg.s ?? seg.start_id);
      const e = Number(seg.e ?? seg.end_id);
      if (!Number.isInteger(s) || !Number.isInteger(e)) continue;
      const startIdx = Math.max(0, Math.min(s, events.length - 1));
      const endIdx = Math.max(startIdx, Math.min(e, events.length - 1));
      result.push({
        start: events[startIdx].start,
        end: events[endIdx].end,
        text: String(seg.o ?? seg.original ?? ""),
        translation: String(seg.t ?? seg.translation ?? ""),
        _si: s,
        _ei: e,
      });
    }
    return result.length ? result : null;
  };

  try {
    return buildResult(JSON.parse(raw));
  } catch {
    try {
      const str = String(raw ?? "");
      const last = Math.max(
        str.lastIndexOf("},"),
        str.lastIndexOf("}\n"),
        str.lastIndexOf("}\r")
      );
      if (last < 0) return null;
      return buildResult(JSON.parse(str.slice(0, last + 1) + "]"));
    } catch {
      return null;
    }
  }
};

const parseSTRes = (raw, events = null) => {
  if (!raw) {
    return [];
  }

  if (events?.length) {
    const indexed = parseIndexSubtitleRes(raw, events);
    if (indexed) return indexed;
  }

  try {
    const data = parseBilingualVtt(raw);
    if (Array.isArray(data)) {
      return data;
    }
  } catch (err) {
    babelLog("parse AI Res: subtitle", err);
  }

  return [];
};

const siliconflowEffortMap = {
  max: 32768,
  high: 16384,
  medium: 8192,
  low: 4096,
  minimal: 2048,
};

/**
 * 注入推理模式（Thinking）的专用控制参数。
 * 针对 DeepSeek, 阿里百炼, 硅基流动, Cerebras, OpenRouter 各大模型厂商繁杂的推理链配置参数进行统一映射注入。
 */
const injectThinking = (body, { apiType, thinkingMode, thinkingEffort }) => {
  if (thinkingMode === "auto") return; // 留空由模型网关自动决定

  const param = THINKING_PARAM_MAP[apiType];
  if (!param) return;

  const hasEffort = thinkingEffort && thinkingEffort !== "_default";

  switch (param.type) {
    case "deepseek":
      body.thinking = {
        type: thinkingMode === "enabled" ? "enabled" : "disabled",
      };
      if (thinkingMode === "enabled" && hasEffort) {
        body.reasoning_effort = thinkingEffort;
      }
      break;
    case "aliyunbailian":
      body.thinking = { type: thinkingMode === "enabled" ? "true" : "false" };
      if (thinkingMode === "enabled" && hasEffort) {
        body.reasoning_effort = thinkingEffort;
      }
      break;
    case "siliconflow":
      body.enable_thinking = thinkingMode === "enabled";
      if (thinkingMode === "enabled" && hasEffort) {
        // 将抽象等级转换为硅基流动所支持的具体思考 tokens 额度
        body.thinking_budget = siliconflowEffortMap[thinkingEffort] || 8192;
      }
      break;
    case "cerebras":
      if (thinkingMode === "disabled") {
        body.reasoning_effort = "none";
      } else if (hasEffort) {
        body.reasoning_effort = thinkingEffort;
      }
      break;
    case "openrouter":
      if (hasEffort) {
        body.reasoning = { effort: thinkingEffort };
      }
      break;
    default:
      break;
  }
};

const genGoogle = ({ texts, from, to, url, key }) => {
  const params = queryString.stringify({
    client: "gtx",
    dt: "t",
    dj: 1,
    ie: "UTF-8",
    sl: from,
    tl: to,
    q: texts.join(" "),
  });
  url = `${url}?${params}`;
  const headers = {
    "Content-type": "application/json",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  return { url, headers, method: "GET" };
};

const genGoogle2 = ({ texts, from, to, url, key }) => {
  const body = [[texts, from, to], "wt_lib"];
  const headers = {
    "Content-Type": "application/json+protobuf",
    "X-Goog-API-Key": key,
  };

  return { url, body, headers };
};

const genMicrosoft = ({ texts, from, to, token }) => {
  const params = queryString.stringify({
    from,
    to,
    "api-version": "3.0",
  });
  const url = `https://api-edge.cognitive.microsofttranslator.com/translate?${params}`;
  const headers = {
    "Content-type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const body = texts.map((text) => ({ Text: text }));

  return { url, body, headers };
};

const genAzureAI = ({ texts, from, to, url, key, region }) => {
  const params = queryString.stringify({
    from,
    to,
  });
  url = url.endsWith("&") ? `${url}${params}` : `${url}&${params}`;
  const headers = {
    "Content-type": "application/json",
    "Ocp-Apim-Subscription-Key": key,
    "Ocp-Apim-Subscription-Region": region,
  };
  const body = texts.map((text) => ({ Text: text }));

  return { url, body, headers };
};

const genDeepl = ({ texts, from, to, url, key }) => {
  const body = {
    text: texts,
    target_lang: to,
    source_lang: from,
    // split_sentences: "0",
  };
  const headers = {
    "Content-type": "application/json",
    Authorization: `DeepL-Auth-Key ${key}`,
  };

  return { url, body, headers };
};

const genDeeplX = ({ texts, from, to, url, key }) => {
  const body = {
    text: texts.join(" "),
    target_lang: to,
    source_lang: from,
  };

  const headers = {
    "Content-type": "application/json",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  return { url, body, headers };
};

const genTencent = ({ texts, from, to }) => {
  const body = {
    header: {
      fn: "auto_translation",
      client_key:
        "browser-chrome-110.0.0-Mac OS-df4bd4c5-a65d-44b2-a40f-42f34f3535f2-1677486696487",
    },
    type: "plain",
    model_category: "normal",
    source: {
      text_list: texts,
      lang: from,
    },
    target: {
      lang: to,
    },
  };

  const url = "https://transmart.qq.com/api/imt";
  const headers = {
    "Content-Type": "application/json",
    "user-agent": DEFAULT_USER_AGENT,
    referer: "https://transmart.qq.com/zh-CN/index",
  };

  return { url, body, headers };
};

const genVolcengine = ({ texts, from, to }) => {
  const body = {
    source_language: from,
    target_language: to,
    text: texts.join(" "),
  };

  const url = "https://translate.volcengine.com/crx/translate/v1";
  const headers = {
    "Content-type": "application/json",
  };

  return { url, body, headers };
};

const genOpenAI = ({
  url,
  key,
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  hisMsgs = [],
  useStream = false,
  apiType,
  thinkingMode,
  thinkingEffort,
  responseFormat,
}) => {
  const userMsg = {
    role: "user",
    content: userPrompt,
  };
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...hisMsgs,
      userMsg,
    ],
    temperature,
    stream: useStream,
  };
  if (apiType === OPT_TRANS_OPENAI) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }
  if (
    responseFormat &&
    (apiType === OPT_TRANS_OPENAI || apiType === OPT_TRANS_DEEPSEEK)
  ) {
    body.response_format = responseFormat;
  }

  injectThinking(body, { apiType, thinkingMode, thinkingEffort });

  const headers = {
    "Content-type": "application/json",
    Authorization: `Bearer ${key}`, // OpenAI
    // "api-key": key, // Azure OpenAI
  };

  return { url, body, headers, userMsg };
};

const genGemini = ({
  url,
  key,
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  hisMsgs = [],
  useStream = false,
  thinkingMode,
  thinkingEffort,
}) => {
  url = url
    .replaceAll(INPUT_PLACE_MODEL, model)
    .replaceAll(INPUT_PLACE_KEY, key);

  // 流式传输使用 streamGenerateContent 端点
  if (useStream) {
    url = url.replace(":generateContent", ":streamGenerateContent");
    url += (url.includes("?") ? "&" : "?") + "alt=sse";
  }

  const userMsg = { role: "user", parts: [{ text: userPrompt }] };

  const body = {
    contents: [
      {
        role: "model",
        parts: [{ text: systemPrompt }],
      },
      ...hisMsgs,
      userMsg,
    ],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  };

  if (thinkingMode === "disabled") {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  } else if (thinkingMode && thinkingMode !== "auto") {
    if (thinkingEffort && thinkingEffort !== "_default") {
      body.generationConfig.thinkingConfig = { thinkingLevel: thinkingEffort };
    }
  }

  Object.assign(body, {
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE",
      },
    ],
  });
  const headers = {
    "Content-type": "application/json",
    "x-goog-api-key": key,
  };

  return { url, body, headers, userMsg };
};

const genGemini2 = ({
  url,
  key,
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  hisMsgs = [],
  useStream = false,
  apiType,
  thinkingMode,
  thinkingEffort,
}) => {
  const userMsg = {
    role: "user",
    content: userPrompt,
  };
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...hisMsgs,
      userMsg,
    ],
    temperature,
    max_tokens: maxTokens,
    stream: useStream,
  };

  injectThinking(body, { apiType, thinkingMode, thinkingEffort });

  const headers = {
    "Content-type": "application/json",
    Authorization: `Bearer ${key}`,
  };

  return { url, body, headers, userMsg };
};

const genClaude = ({
  url,
  key,
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  hisMsgs = [],
  useStream = false,
  thinkingMode,
  thinkingEffort,
}) => {
  const userMsg = {
    role: "user",
    content: userPrompt,
  };
  const body = {
    model,
    system: systemPrompt,
    messages: [...hisMsgs, userMsg],
    temperature,
    max_tokens: maxTokens,
    stream: useStream,
  };

  if (thinkingMode && thinkingMode !== "auto") {
    if (thinkingMode === "enabled") {
      body.thinking = { type: "adaptive" };
      if (thinkingEffort && thinkingEffort !== "_default") {
        body.output_config = { effort: thinkingEffort };
      }
    }
  }

  const headers = {
    "Content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-api-key": key,
  };

  return { url, body, headers, userMsg };
};

const genOpenRouter = ({
  url,
  key,
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  hisMsgs = [],
  useStream = false,
  thinkingMode,
  thinkingEffort,
}) => {
  const userMsg = {
    role: "user",
    content: userPrompt,
  };
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...hisMsgs,
      userMsg,
    ],
    temperature,
    max_tokens: maxTokens,
    stream: useStream,
  };

  injectThinking(body, {
    apiType: OPT_TRANS_OPENROUTER,
    thinkingMode,
    thinkingEffort,
  });

  const headers = {
    "Content-type": "application/json",
    Authorization: `Bearer ${key}`,
  };

  return { url, body, headers, userMsg };
};

const genOllama = ({
  url,
  key,
  systemPrompt,
  userPrompt,
  model,
  temperature,
  maxTokens,
  hisMsgs = [],
  useStream = false,
  thinkingMode,
  thinkingEffort,
}) => {
  const userMsg = {
    role: "user",
    content: userPrompt,
  };
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      ...hisMsgs,
      userMsg,
    ],
    temperature,
    max_tokens: maxTokens,
  };

  injectThinking(body, {
    apiType: OPT_TRANS_OLLAMA,
    thinkingMode,
    thinkingEffort,
  });
  body.stream = useStream;

  const headers = {
    "Content-type": "application/json",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  return { url, body, headers, userMsg };
};

const genCloudflareAI = ({ texts, from, to, url, key }) => {
  const body = {
    text: texts.join(" "),
    source_lang: from,
    target_lang: to,
  };

  const headers = {
    "Content-type": "application/json",
    Authorization: `Bearer ${key}`,
  };

  return { url, body, headers };
};

const genCustom = ({ texts, fromLang, toLang, url, key, useBatchFetch }) => {
  const body = useBatchFetch
    ? { texts, from: fromLang, to: toLang }
    : { text: texts[0], from: fromLang, to: toLang };
  const headers = {
    "Content-type": "application/json",
    Authorization: `Bearer ${key}`,
  };

  return { url, body, headers };
};

const genReqFuncs = {
  [OPT_TRANS_GOOGLE]: genGoogle,
  [OPT_TRANS_GOOGLE_2]: genGoogle2,
  [OPT_TRANS_MICROSOFT]: genMicrosoft,
  [OPT_TRANS_AZUREAI]: genAzureAI,
  [OPT_TRANS_DEEPL]: genDeepl,
  [OPT_TRANS_DEEPLFREE]: genDeeplFree,
  [OPT_TRANS_DEEPSEEK]: genOpenAI,
  [OPT_TRANS_SILICONFLOW]: genOpenAI,
  [OPT_TRANS_XIAOMIMIMO]: genOpenAI,
  [OPT_TRANS_ALIYUNBAILIAN]: genOpenAI,
  [OPT_TRANS_CEREBRAS]: genOpenAI,
  [OPT_TRANS_ZAI]: genOpenAI,
  [OPT_TRANS_DEEPLX]: genDeeplX,
  [OPT_TRANS_EPHONEAI]: genOpenAI,
  [OPT_TRANS_BAIDU]: genBaidu,
  [OPT_TRANS_TENCENT]: genTencent,
  [OPT_TRANS_VOLCENGINE]: genVolcengine,
  [OPT_TRANS_OPENAI]: genOpenAI,
  [OPT_TRANS_GEMINI]: genGemini,
  [OPT_TRANS_GEMINI_2]: genGemini2,
  [OPT_TRANS_CLAUDE]: genClaude,
  [OPT_TRANS_CLOUDFLAREAI]: genCloudflareAI,
  [OPT_TRANS_OLLAMA]: genOllama,
  [OPT_TRANS_OPENROUTER]: genOpenRouter,
  [OPT_TRANS_CUSTOMIZE]: genCustom,
};

/**
 * 构建统一的 Fetch init 对象。
 * 对请求体和方法做健全处理。
 */
const genInit = ({
  url = "",
  body = null,
  headers = {},
  userMsg = null,
  method = "POST",
}) => {
  if (!url) {
    throw new Error("genInit: url is empty");
  }

  const init = {
    method,
    headers,
  };
  if (method !== "GET" && method !== "HEAD" && body) {
    let payload = JSON.stringify(body);
    const id = body?.params?.id;

    // REVIEW: 极其硬核的 WAF (网关指纹防火墙) 特征规避设计！
    // 很多公开的 JSON-RPC 翻译网关由于序列化格式完全一致，极易被 WAF 通过报文指纹拦截阻断。
    // 此处针对 body 中的随机 id 动态对方法字段进行了微小的空格格式抖动（在冒号前或后加入空格），
    // 能够破坏 WAF 的静态字符串指纹匹配，达到长期稳定抗封防盾的效果。
    if (id) {
      payload = payload.replace(
        'method":"',
        (id + 3) % 13 === 0 || (id + 5) % 29 === 0
          ? 'method" : "'
          : 'method": "'
      );
    }
    Object.assign(init, { body: payload });
  }

  return [url, init, userMsg];
};

/**
 * 构造翻译接口请求参数
 * @param {*}
 * @returns
 */
export const genTransReq = async ({ reqHook, ...args }) => {
  const {
    apiType,
    apiSlug,
    key,
    systemPrompt,
    subtitlePrompt,
    // userPrompt,
    nobatchPrompt = defaultNobatchPrompt,
    nobatchUserPrompt = defaultNobatchUserPrompt,
    useBatchFetch,
    from,
    to,
    fromLang,
    toLang,
    texts,
    glossary,
    aiTerms,
    customHeader,
    customBody,
    events,
    tone,
    prevContext,
    nextContext,
    contextBefore,
    contextAfter,
    docInfo: externalDocInfo,
    contextDocInfo,
  } = args;

  // 向后兼容：旧配置无此字段时默认开启
  const enableDocContext = contextDocInfo !== false;

  if (API_SPE_TYPES.mulkeys.has(apiType)) {
    args.key = keyPick(apiSlug, key, keyMap);
  }

  if (apiType === OPT_TRANS_DEEPLX) {
    args.url = keyPick(apiSlug, args.url, urlMap);
  }

  if (API_SPE_TYPES.ai.has(apiType)) {
    const hasExternalDocInfo =
      externalDocInfo &&
      (externalDocInfo.title ||
        externalDocInfo.description ||
        externalDocInfo.summary);
    const docInfo = enableDocContext
      ? hasExternalDocInfo
        ? externalDocInfo
        : getDocInfo()
      : {};
    const userDocInfo = enableDocContext
      ? hasExternalDocInfo
        ? {}
        : docInfo
      : {};

    let baseSystemPrompt = events
      ? genSubtitlePrompt({
          subtitlePrompt,
          from,
          to,
          fromLang,
          toLang,
          texts,
          docInfo,
          tone,
          aiTerms,
        })
      : genSystemPrompt({
          systemPrompt: useBatchFetch ? systemPrompt : nobatchPrompt,
          from,
          to,
          fromLang,
          toLang,
          texts,
          docInfo,
          tone,
        });

    // 上下文回退：当 prompt 模板缺少占位符时，追加 # Context 块
    if (enableDocContext && hasExternalDocInfo) {
      const template = events
        ? subtitlePrompt
        : useBatchFetch
          ? systemPrompt
          : nobatchPrompt;
      const parts = [];
      if (docInfo.title && !template.includes(INPUT_PLACE_TITLE))
        parts.push(`Title: ${docInfo.title}`);
      if (docInfo.description && !template.includes(INPUT_PLACE_DESCRIPTION))
        parts.push(`Description: ${docInfo.description}`);
      if (docInfo.summary && !template.includes(INPUT_PLACE_SUMMARY))
        parts.push(`Summary: ${docInfo.summary}`);
      if (parts.length) {
        baseSystemPrompt += `\n\n# Context\n${parts.join("\n")}`;
      }
    }

    args.systemPrompt = baseSystemPrompt;
    args.userPrompt = events
      ? buildSubtitleUserPrompt({
          formattedEvents: usesIndexSubtitleInput(subtitlePrompt)
            ? formatIndexSubtitleEvents(events)
            : events,
          prevContext,
          nextContext,
        })
      : genUserPrompt({
          nobatchUserPrompt,
          useBatchFetch,
          from,
          to,
          fromLang,
          toLang,
          texts,
          contextBefore,
          contextAfter,
          docInfo: userDocInfo,
          tone,
          glossary,
          aiTerms,
        });
  }

  const {
    url = "",
    body = null,
    headers = {},
    userMsg = null,
    method = "POST",
  } = genReqFuncs[apiType](args);

  if (events && apiType === OPT_TRANS_GEMINI && body?.generationConfig) {
    body.generationConfig.responseMimeType = "application/json";
  }

  // 合并用户自定义headers和body
  if (customHeader?.trim()) {
    Object.assign(headers, parseJsonObj(customHeader));
  }
  if (customBody?.trim()) {
    Object.assign(body, parseJsonObj(customBody));
  }

  // 执行 request hook
  if (reqHook?.trim() && !events) {
    try {
      const req = {
        url,
        body,
        headers,
        userMsg,
        method,
      };
      interpreter.run(`exports.reqHook = ${reqHook}`);
      const hookResult = await interpreter.exports.reqHook(
        {
          ...args,
          defaultSystemPrompt,
          defaultSystemPromptXml,
          defaultSystemPromptLines,
          defaultSubtitlePrompt,
          defaultNobatchPrompt,
          defaultNobatchUserPrompt,
          req,
        },
        req
      );
      if (hookResult && hookResult.url) {
        return genInit(hookResult);
      }
    } catch (err) {
      babelLog("run req hook", err);
      throw new Error(`Request hook error: ${err.message}`);
    }
  }

  return genInit({ url, body, headers, userMsg, method });
};

/**
 * 解析翻译接口返回数据
 * @param {*} res
 * @param {*} param3
 * @returns
 */
export const parseTransRes = async (
  res,
  {
    texts,
    from,
    to,
    fromLang,
    toLang,
    langMap,
    resHook,
    // thinkIgnore,
    history,
    userMsg,
    apiType,
    useBatchFetch,
    strictBatchFetch,
    expectedBatchIds,
  }
) => {
  // 执行 response hook
  if (resHook?.trim()) {
    try {
      interpreter.run(`exports.resHook = ${resHook}`);
      const hookResult = await interpreter.exports.resHook({
        apiType,
        userMsg,
        res,
        texts,
        from,
        to,
        fromLang,
        toLang,
        langMap,
        extractJson,
        parseAIRes,
      });
      if (hookResult && Array.isArray(hookResult.translations)) {
        if (history && userMsg && hookResult.modelMsg) {
          history.add(userMsg, hookResult.modelMsg);
        }
        return hookResult.translations;
      } else if (Array.isArray(hookResult)) {
        return hookResult;
      }
    } catch (err) {
      babelLog("run res hook", err);
      throw new Error(`Response hook error: ${err.message}`);
    }
  }

  let modelMsg = "";

  // todo: 根据结果抛出实际异常信息
  switch (apiType) {
    case OPT_TRANS_GOOGLE:
      return [[res?.sentences?.map((item) => item.trans).join(" "), res?.src]];
    case OPT_TRANS_GOOGLE_2:
      return res?.[0]?.map((_, i) => [res?.[0]?.[i], res?.[1]?.[i]]);
    case OPT_TRANS_MICROSOFT:
    case OPT_TRANS_AZUREAI:
      return res?.map((item) => [
        item.translations.map((item) => item.text).join(" "),
        item.detectedLanguage?.language,
      ]);
    case OPT_TRANS_DEEPL:
      return res?.translations?.map((item) => [
        item.text,
        item.detected_source_language,
      ]);
    case OPT_TRANS_DEEPLFREE:
      return [
        [
          res?.result?.texts?.map((item) => item.text).join(" "),
          res?.result?.lang,
        ],
      ];
    case OPT_TRANS_DEEPLX:
      return [[res?.data, res?.source_lang]];
    case OPT_TRANS_BAIDU:
      if (res.type === 1) {
        return [
          [
            Object.keys(JSON.parse(res.result).content[0].mean[0].cont)[0],
            res.from,
          ],
        ];
      } else if (res.type === 2) {
        return [[res.data.map((item) => item.dst).join(" "), res.from]];
      }
      break;
    case OPT_TRANS_TENCENT:
      return res?.auto_translation?.map((text) => [text, res?.src_lang]);
    case OPT_TRANS_VOLCENGINE:
      return [[res?.translation, res?.detected_language]];
    case OPT_TRANS_EPHONEAI:
    case OPT_TRANS_OPENAI:
    case OPT_TRANS_DEEPSEEK:
    case OPT_TRANS_SILICONFLOW:
    case OPT_TRANS_XIAOMIMIMO:
    case OPT_TRANS_ALIYUNBAILIAN:
    case OPT_TRANS_CEREBRAS:
    case OPT_TRANS_ZAI:
    case OPT_TRANS_GEMINI_2:
    case OPT_TRANS_OPENROUTER:
      modelMsg = res?.choices?.[0]?.message;
      if (history && userMsg && modelMsg) {
        history.add(userMsg, {
          role: modelMsg.role,
          content: modelMsg.content,
        });
      }
      if (strictBatchFetch) {
        const strictResult = parseStrictSubtitleChunkResult(
          modelMsg?.content,
          expectedBatchIds
        );
        if (!strictResult.ok) {
          throw new Error(`Strict batch parse failed: ${strictResult.error}`);
        }
        return strictResult.translations.map((text) => [text, ""]);
      }
      return parseAIRes(modelMsg?.content, useBatchFetch);
    case OPT_TRANS_GEMINI:
      modelMsg = res?.candidates?.[0]?.content;
      if (history && userMsg && modelMsg) {
        history.add(userMsg, modelMsg);
      }
      {
        const rawText = geminiText(modelMsg?.parts);
        if (strictBatchFetch) {
          const strictResult = parseStrictSubtitleChunkResult(
            rawText,
            expectedBatchIds
          );
          if (!strictResult.ok) {
            throw new Error(`Strict batch parse failed: ${strictResult.error}`);
          }
          return strictResult.translations.map((text) => [text, ""]);
        }
        return parseAIRes(rawText, useBatchFetch);
      }
    case OPT_TRANS_CLAUDE:
      modelMsg = { role: res?.role, content: res?.content?.text };
      if (history && userMsg && modelMsg) {
        history.add(userMsg, {
          role: modelMsg.role,
          content: modelMsg.content,
        });
      }
      {
        const rawText = res?.content?.[0]?.text ?? "";
        if (strictBatchFetch) {
          const strictResult = parseStrictSubtitleChunkResult(
            rawText,
            expectedBatchIds
          );
          if (!strictResult.ok) {
            throw new Error(`Strict batch parse failed: ${strictResult.error}`);
          }
          return strictResult.translations.map((text) => [text, ""]);
        }
        return parseAIRes(rawText, useBatchFetch);
      }
    case OPT_TRANS_CLOUDFLAREAI:
      return [[res?.result?.translated_text]];
    case OPT_TRANS_OLLAMA:
      modelMsg = res?.choices?.[0]?.message;

      // const deepModels = thinkIgnore
      //   .split(",")
      //   .filter((model) => model?.trim());
      // if (deepModels.some((model) => res?.model?.startsWith(model))) {
      //   modelMsg?.content.replace(/<think>[\s\S]*<\/think>/i, "");
      // }

      if (history && userMsg && modelMsg) {
        history.add(userMsg, {
          role: modelMsg.role,
          content: modelMsg.content,
        });
      }
      if (strictBatchFetch) {
        const strictResult = parseStrictSubtitleChunkResult(
          modelMsg?.content,
          expectedBatchIds
        );
        if (!strictResult.ok) {
          throw new Error(`Strict batch parse failed: ${strictResult.error}`);
        }
        return strictResult.translations.map((text) => [text, ""]);
      }
      return parseAIRes(modelMsg?.content, useBatchFetch);
    case OPT_TRANS_CUSTOMIZE:
      if (useBatchFetch) {
        return (res?.translations ?? res)?.map((item) => [item.text, item.src]);
      }
      return [[res.text, res.src || res.from]];
    default:
  }

  throw new Error("parse translate result: apiType not matched", apiType);
};

/**
 * 发送翻译请求并解析
 * 支持流式和非流式两种模式
 * @param {*} texts 待翻译文本数组
 * @param {*} options 翻译选项
 * @yields {{id: number, result: [string, string]}} 流式模式下逐个返回结果
 * @returns {Promise<Array>} 非流式模式下返回完整结果数组
 */
export async function* handleTranslate(
  texts = [],
  {
    from,
    to,
    fromLang,
    toLang,
    langMap,
    glossary,
    apiSetting,
    usePool,
    docInfo,
    contextBefore,
    contextAfter,
    signal,
  }
) {
  if (signal?.aborted) return;

  let history = null;
  let hisMsgs = [];
  const {
    apiType,
    apiSlug,
    contextSize,
    contextChatHistory,
    useContext,
    fetchInterval,
    fetchLimit,
    httpTimeout,
    useStream,
  } = apiSetting;
  // 向后兼容：旧配置的 useContext 映射为 contextChatHistory
  const enableChatHistory =
    contextChatHistory === true ||
    (contextChatHistory === undefined && useContext === true);
  if (enableChatHistory && API_SPE_TYPES.context.has(apiType)) {
    history = getMsgHistory(apiSlug, contextSize);
    hisMsgs = history.getAll();
  }

  const enableStream = useStream && API_SPE_TYPES.stream.has(apiType);

  let token = "";
  if (apiType === OPT_TRANS_MICROSOFT) {
    token = await msAuth();
    if (!token) {
      throw new Error("got msauth error");
    }
  }

  const [input, init, userMsg] = await genTransReq({
    ...apiSetting,
    texts,
    from,
    to,
    fromLang,
    toLang,
    langMap,
    glossary,
    hisMsgs,
    token,
    useStream: enableStream,
    docInfo,
    contextBefore,
    contextAfter,
  });

  if (enableStream) {
    yield* handleTranslateStreamInternal(texts, input, init, {
      apiType,
      history,
      userMsg,
      usePool,
      fetchInterval,
      fetchLimit,
      httpTimeout,
      streamRenderMode: apiSetting.streamRenderMode || "disabled",
    });
  } else {
    // 诊断日志：打印完整提示词和 LLM 回包（INFO 级别避免被过滤）
    if (API_SPE_TYPES.ai.has(apiType) && init?.body) {
      try {
        const reqBody = JSON.parse(init.body);
        const msgs = reqBody.messages;
        if (msgs) {
          babelLog(
            "INFO",
            `[DIAG] REQUEST — ${msgs.length} messages, model: ${reqBody.model || "?"}`
          );
          msgs.forEach((m, i) => {
            const content =
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content);
            babelLog(
              "INFO",
              `[DIAG]   [${i}] ${m.role}: ${content.slice(0, 2000)}${content.length > 2000 ? `...(+${content.length - 2000})` : ""}`
            );
          });
        }
      } catch {}
    }

    const response = await fetchData(input, init, {
      useCache: false,
      usePool,
      fetchInterval,
      fetchLimit,
      httpTimeout,
    });
    if (!response) {
      throw new Error("translate got empty response");
    }

    // 诊断日志：打印 LLM 原始回包（INFO 级别避免被过滤）
    if (API_SPE_TYPES.ai.has(apiType)) {
      let rawContent = "";
      rawContent =
        response?.choices?.[0]?.message?.content ||
        response?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text)
          .join("") ||
        response?.content?.[0]?.text ||
        "";
      if (rawContent) {
        babelLog(
          "INFO",
          `[DIAG] RESPONSE (${rawContent.length} chars): ${rawContent.slice(0, 3000)}${rawContent.length > 3000 ? `...(+${rawContent.length - 3000})` : ""}`
        );
      }
    }

    const result = await parseTransRes(response, {
      texts,
      from,
      to,
      fromLang,
      toLang,
      langMap,
      history,
      userMsg,
      ...apiSetting,
    });
    if (!result?.length) {
      throw new Error("translate got an unexpected result");
    }

    for (let i = 0; i < result.length; i++) {
      yield { id: i, result: result[i] };
    }
  }
}

/**
 * 内部流式翻译处理
 */
async function* handleTranslateStreamInternal(
  texts,
  input,
  init,
  {
    apiType,
    history,
    userMsg,
    usePool,
    fetchInterval,
    fetchLimit,
    httpTimeout,
    streamRenderMode,
  }
) {
  const results = new Array(texts.length).fill(null);
  let fullContent = "";
  const processedIds = new Set();

  const jsonParser = createStreamingJsonParser();
  const realtimeParser =
    streamRenderMode === "realtime" ? createRealtimeStreamParser() : null;
  let isJsonFormat = false;
  let formatDetected = false;

  try {
    for await (const rawData of fetchStream(input, init, {
      useCache: false,
      usePool,
      fetchInterval,
      fetchLimit,
      httpTimeout,
    })) {
      try {
        const json = JSON.parse(rawData);
        const delta = getStreamDelta(json, apiType);

        if (delta) {
          fullContent += delta;
          fullContent = stripMarkdownCodeBlock(fullContent, true);

          if (!formatDetected) {
            const { isJson, detected } = detectStreamFormat(fullContent);
            if (detected) {
              formatDetected = true;
              isJsonFormat = isJson;
              // 格式检测成功后，将累积的内容写入解析器
              if (isJsonFormat) {
                for (const { id, translation } of jsonParser.write(
                  fullContent
                )) {
                  results[id] = translation;
                  yield { id, result: translation };
                }
              }
            }
          } else if (isJsonFormat) {
            for (const { id, translation } of jsonParser.write(delta)) {
              results[id] = translation;
              yield { id, result: translation };
            }
          } else {
            for (const { id, translation } of parseStreamingSegments(
              fullContent,
              processedIds
            )) {
              results[id] = translation;
              yield { id, result: translation };
            }
          }
          // 实时渲染模式：yield 段落级中间态
          if (realtimeParser && streamRenderMode === "realtime") {
            const items = realtimeParser.write(delta);
            for (const { id, partialText, isComplete } of items) {
              if (!isComplete) {
                yield { id, partialText, isComplete: false };
              }
            }
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    }

    if (isJsonFormat) {
      jsonParser.end();
    }
  } catch (error) {
    babelLog("handleTranslateStream error", error);
    throw error;
  }

  // 最终再解析一次，捕获可能遗漏的段落
  const hasEmpty = results.some((r) => !r);
  if (hasEmpty) {
    const parsed = parseAIRes(fullContent, true);
    for (let i = 0; i < texts.length && i < parsed.length; i++) {
      if (!results[i]) {
        results[i] = parsed[i];
        yield { id: i, result: results[i] };
      }
    }
  }

  if (history && userMsg) {
    if (apiType === OPT_TRANS_GEMINI) {
      history.add(userMsg, {
        role: "model",
        parts: [{ text: fullContent }],
      });
    } else {
      history.add(userMsg, {
        role: "assistant",
        content: fullContent,
      });
    }
  }
}

/**
 * Microsoft语言识别聚合及解析
 * @param {*} texts
 * @returns
 */
export const handleMicrosoftLangdetect = async (texts = []) => {
  const token = await msAuth();
  const input =
    "https://api-edge.cognitive.microsofttranslator.com/detect?api-version=3.0";
  const init = {
    headers: {
      "Content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    method: "POST",
    body: JSON.stringify(texts.map((text) => ({ Text: text }))),
  };

  const res = await fetchData(input, init, {
    useCache: false,
  });

  if (Array.isArray(res)) {
    return res.map((r) => r.language);
  }

  return [];
};

/**
 * 字幕翻译
 * @param {*} param0
 * @returns
 */
export const handleSubtitle = async ({
  events,
  from,
  to,
  apiSetting,
  docInfo,
  prevContext = "",
  nextContext = "",
  signal,
}) => {
  const { apiType, fetchInterval, fetchLimit, httpTimeout } = apiSetting;

  const [input, init] = await genTransReq({
    ...apiSetting,
    events,
    from,
    to,
    docInfo,
    prevContext,
    nextContext,
  });

  // 透传 AbortController signal，使视频切换时可取消进行中的 LLM 请求
  if (signal) init.signal = signal;

  const res = await fetchData(input, init, {
    useCache: false,
    usePool: true,
    fetchInterval,
    fetchLimit,
    httpTimeout,
  });
  if (!res) {
    babelLog("subtitle got empty response");
    return [];
  }

  switch (apiType) {
    case OPT_TRANS_OPENAI:
    case OPT_TRANS_GEMINI_2:
    case OPT_TRANS_OPENROUTER:
    case OPT_TRANS_OLLAMA:
      return parseSTRes(res?.choices?.[0]?.message?.content ?? "", events);
    case OPT_TRANS_GEMINI: {
      const candidate = res?.candidates?.[0];
      const { thinkingMode } = apiSetting;
      const thinkingWasOn =
        thinkingMode && thinkingMode !== "auto" && thinkingMode !== "disabled";

      if (candidate?.finishReason === "MAX_TOKENS" && thinkingWasOn) {
        // 如果 signal 已被 abort，跳过重试
        if (signal?.aborted) return [];

        const [retryInput, retryInit] = await genTransReq({
          ...apiSetting,
          thinkingMode: "disabled",
          events,
          from,
          to,
          docInfo,
          prevContext,
          nextContext,
        });
        if (signal) retryInit.signal = signal;

        const retryRes = await fetchData(retryInput, retryInit, {
          useCache: false,
          usePool: true,
          fetchInterval,
          fetchLimit,
          httpTimeout,
        });
        if (retryRes?.candidates?.[0]?.content?.parts) {
          return parseSTRes(
            geminiText(retryRes.candidates[0].content.parts),
            events
          );
        }
      }
      return parseSTRes(geminiText(candidate?.content?.parts), events);
    }
    case OPT_TRANS_CLAUDE:
      return parseSTRes(res?.content?.[0]?.text ?? "", events);
    case OPT_TRANS_CUSTOMIZE:
      return res;
    default:
  }

  return [];
};
