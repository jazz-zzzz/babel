export const countFilledTranslations = (translations = []) =>
  (Array.isArray(translations) ? translations : []).filter((text) =>
    String(text || "").trim()
  ).length;

export const getSubtitleTranslationProgress = (texts = [], translations) => {
  const expected = countFilledTranslations(texts);
  if (!expected) return 100;

  const filled = countFilledTranslations(translations);
  if (!filled) return 1;

  return Math.min(99, Math.max(1, Math.floor((filled / expected) * 100)));
};

export const getMissingSubtitleTranslationIndexes = (
  texts = [],
  translations = []
) => {
  if (!Array.isArray(texts)) return [];
  const safeTranslations = Array.isArray(translations) ? translations : [];

  return texts.reduce((indexes, text, index) => {
    if (
      String(text || "").trim() &&
      !String(safeTranslations[index] || "").trim()
    ) {
      indexes.push(index);
    }
    return indexes;
  }, []);
};

export const isCompleteSubtitleTranslationBatch = (
  texts = [],
  translations = []
) => {
  if (!Array.isArray(texts) || !Array.isArray(translations)) return false;
  if (translations.length < texts.length) return false;

  return texts.every((text, index) => {
    if (!String(text || "").trim()) return true;
    return Boolean(String(translations[index] || "").trim());
  });
};

export const isInitialSubtitleChunkReady = (
  subtitles = [],
  firstChunkSize = 20
) => {
  if (!Array.isArray(subtitles) || !subtitles.length) return false;
  const firstTextSubtitles = subtitles
    .filter((subtitle) => String(subtitle?.text || "").trim())
    .slice(0, Math.max(1, firstChunkSize));

  if (!firstTextSubtitles.length) return false;
  return firstTextSubtitles.every((subtitle) =>
    String(subtitle?.translation || "").trim()
  );
};

export const runSubtitleChunksFirstThenAll = async (chunks = [], translateChunk) => {
  if (!Array.isArray(chunks) || !chunks.length) return [];
  if (typeof translateChunk !== "function") {
    throw new TypeError("translateChunk must be a function");
  }

  const firstResult = await translateChunk(chunks[0]);
  const restResults = await Promise.all(chunks.slice(1).map(translateChunk));
  return [firstResult, ...restResults];
};
export const splitSubtitleTranslationChunks = (
  texts = [],
  {
    firstChunkSize = 20,
    secondChunkSize = 40,
    chunkSize = 80,
    contextSize = 10,
  } = {}
) => {
  if (!Array.isArray(texts) || !texts.length) return [];

  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < texts.length) {
    const size =
      index === 0 ? firstChunkSize : index === 1 ? secondChunkSize : chunkSize;
    const end = Math.min(texts.length, start + Math.max(1, size));
    const chunkStart = start;
    const chunkEnd = end;
    const segmentIds = Array.from(
      { length: chunkEnd - chunkStart },
      (_, i) => chunkStart + i
    );
    const beforeStart = Math.max(0, chunkStart - contextSize);
    const afterEnd = Math.min(texts.length, chunkEnd + contextSize);

    chunks.push({
      start: chunkStart,
      end: chunkEnd,
      segmentIds,
      texts: texts.slice(chunkStart, chunkEnd),
      contextBefore: texts.slice(beforeStart, chunkStart).map((text, i) => ({
        globalIndex: beforeStart + i,
        text,
      })),
      contextAfter: texts.slice(chunkEnd, afterEnd).map((text, i) => ({
        globalIndex: chunkEnd + i,
        text,
      })),
    });

    start = end;
    index += 1;
  }

  return chunks;
};

export const parseStrictSubtitleChunkResult = (raw, expectedIds = []) => {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "top-level result must be an object" };
    }
    if (!Array.isArray(parsed.items)) {
      return { ok: false, error: "items must be an array" };
    }
    if (parsed.items.length !== expectedIds.length) {
      return { ok: false, error: "items length mismatch" };
    }

    const expectedSet = new Set(expectedIds);
    const seen = new Set();
    const byId = new Map();
    for (const item of parsed.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, error: "item must be an object" };
      }
      if (!Number.isInteger(item.id)) {
        return { ok: false, error: "item id must be an integer" };
      }
      if (!expectedSet.has(item.id)) {
        return { ok: false, error: "unexpected item id" };
      }
      if (seen.has(item.id)) {
        return { ok: false, error: "duplicate item id" };
      }
      if (typeof item.text !== "string" || !item.text.trim()) {
        return {
          ok: false,
          error: `item text must be a non-empty string: id ${item.id}`,
        };
      }
      seen.add(item.id);
      byId.set(item.id, item.text);
    }

    if (seen.size !== expectedIds.length) {
      return { ok: false, error: "missing item id" };
    }

    return {
      ok: true,
      translations: expectedIds.map((id) => byId.get(id)),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

export const buildBatchSubtitleSystemPrompt = ({ count, toLang }) => `You are translating a COMPLETE video subtitle transcript. All ${count} segments are in the user message as a JSON array of {"id":N,"text":"..."} objects.

CRITICAL: You MUST return ONLY a JSON array with exactly ${count} objects, each with "id" (number) and "text" (string). The "id" MUST match the input segment exactly. Wrong id = wrong subtitle.

OUTPUT SIZE RULE:
- Return compact minified JSON: no spaces or newlines outside string values.
- The response MUST start with [{"id":0,"text":" and continue until the final id ${Math.max(0, count - 1)}.

EXAMPLE INPUT:
{"targetLanguage":"zh-CN","segments":[{"id":0,"text":"Hello"},{"id":1,"text":"How are you?"}]}

EXAMPLE OUTPUT:
[{"id":0,"text":"你好"},{"id":1,"text":"你好吗？"}]

STRICT RULES:
- Return ONLY the raw JSON array. NO markdown, NO explanations, NO {"translations":[...]} wrapper.
- Do NOT reorder, skip, merge, split, or invent ids.
- JSON syntax MUST be perfect: every key quoted, every comma correct, no trailing commas.
- Test your JSON in your head before outputting.

TRANSLATION QUALITY:
- Read ALL segments first to understand the full transcript context.
- Use consistent terminology, character names, tone, and style throughout.
- Translate naturally into ${toLang}. Preserve proper nouns and technical terms as-is.`;


const joinReadonlyContextText = (items = []) =>
  items
    .map((item) => String(item?.text || "").trim())
    .filter(Boolean)
    .join("\n");

export const buildBatchSubtitleUserPrompt = ({
  toLang,
  texts = [],
  contextBefore = [],
  contextAfter = [],
  docInfo: { title = "", description = "" } = {},
}) => {
  const promptObj = {
    task: {
      targetLanguage: toLang,
      translateOnly: "payload.segmentsToTranslate",
      outputIds: texts.map((_, id) => id),
    },
    payload: {
      segmentsToTranslate: texts.map((text, id) => ({ id, source: text })),
    },
  };

  const beforeText = joinReadonlyContextText(contextBefore);
  const afterText = joinReadonlyContextText(contextAfter);
  if (beforeText || afterText) {
    promptObj.readonlyContext = {};
    if (beforeText) promptObj.readonlyContext.beforeText = beforeText;
    if (afterText) promptObj.readonlyContext.afterText = afterText;
  }

  if (title) promptObj.title = title;
  if (description) promptObj.description = description;

  return JSON.stringify(promptObj);
};

export const buildStrictChunkSubtitleSystemPrompt = ({ count, toLang }) => `You are a subtitle translation engine. Translate ONLY payload.segmentsToTranslate into ${toLang}. readonlyContext is reference-only and is NOT part of the translation task.

INPUT CONTRACT:
- payload.segmentsToTranslate is the only array whose objects require translation.
- readonlyContext.beforeText and readonlyContext.afterText are read-only reference text. They may help resolve terminology, pronouns, tone, and incomplete sentence fragments.
- Never create output for readonlyContext. Never translate readonlyContext as items. Never copy, merge, summarize, continue, or complete readonlyContext into any item.

OUTPUT CONTRACT:
Return ONLY one valid compact JSON object with exactly this shape:
{"items":[{"id":0,"text":"translated text"}]}

STRICT RULES:
- The "items" array MUST contain exactly ${count} objects.
- Each output "id" MUST exactly match one input id from payload.segmentsToTranslate.
- For each output item, translate only the "source" text from the segment with the same id.
- Never move meaning, words, clauses, or sentence continuations across ids, even when adjacent context forms a larger sentence.
- Do NOT reorder, skip, merge, split, invent, or duplicate ids.
- Every "text" MUST be a non-empty translated string.
- No markdown, no explanations, no extra top-level keys.

TRANSLATION QUALITY:
- Translate naturally into ${toLang}.
- Preserve proper nouns and technical terms as-is when appropriate.
- Prefer faithful id-by-id alignment over smoothing across subtitle boundaries.`;

export const createBatchSubtitleApiSetting = ({
  apiSetting,
  isAI,
  texts,
  toLang,
  defaultHttpTimeout,
  strict = false,
}) => {
  const count = Array.isArray(texts) ? texts.length : 0;
  const batchTimeout = Math.max(
    (apiSetting.httpTimeout || defaultHttpTimeout) * 10,
    count * 2000,
    30000
  );

  const thinkingDefaults =
    apiSetting.apiType === "DeepSeek"
      ? { thinkingMode: "disabled", thinkingEffort: "_default" }
      : {};

  return {
    ...apiSetting,
    ...thinkingDefaults,
    systemPrompt: isAI
      ? strict
        ? buildStrictChunkSubtitleSystemPrompt({ count, toLang })
        : buildBatchSubtitleSystemPrompt({ count, toLang })
      : apiSetting.systemPrompt,
    httpTimeout: batchTimeout,
    useBatchFetch: true,
    useStream: false,
    strictBatchFetch: strict,
    expectedBatchIds: strict
      ? Array.from({ length: count }, (_, id) => id)
      : undefined,
    responseFormat: strict ? { type: "json_object" } : undefined,
    contextChatHistory: false,
    useContext: false,
    contextSize: 0,
    maxTokens: strict
      ? Math.max(2048, count * 80)
      : Math.max(apiSetting.maxTokens ?? 0, 32768),
  };
};
