import {
  buildBatchSubtitleSystemPrompt,
  buildBatchSubtitleUserPrompt,
  buildStrictChunkSubtitleSystemPrompt,
  countFilledTranslations,
  createBatchSubtitleApiSetting,
  getMissingSubtitleTranslationIndexes,
  getSubtitleTranslationProgress,
  isCompleteSubtitleTranslationBatch,
  isInitialSubtitleChunkReady,
  parseStrictSubtitleChunkResult,
  runSubtitleChunksFirstThenAll,
  splitSubtitleTranslationChunks,
} from "./subtitleBatch.js";

// 模拟 parseAIRes 正则在真实 LLM 回包上的表现
const OBJ_RE = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

/** 用正则从 LLM 回包提取 indexed[id] = translatedText */
function parseLLMResponse(raw) {
  const indexed = [];
  let match;
  while ((match = OBJ_RE.exec(raw)) !== null) {
    const id = parseInt(match[1], 10);
    const text = match[2].replace(/\\(.)/g, "$1"); // 还原转义
    if (Number.isInteger(id) && text) {
      indexed[id] = String(text);
    }
  }
  // 稀疏转稠密
  for (let i = 0; i < indexed.length; i++) {
    if (!indexed[i]) indexed[i] = "";
  }
  return indexed;
}

/** 模拟 #batchTranslateAll 核心映射逻辑 */
function mapTranslationsToSubtitles(subtitles, translations) {
  // 收集非空原文及其原始索引
  const textIndices = [];
  const texts = [];
  subtitles.forEach((sub, i) => {
    if (sub.text?.trim()) {
      textIndices.push(i);
      texts.push(sub.text.trim());
    }
  });

  // 回填翻译
  const result = [...subtitles];
  textIndices.forEach((originalIndex, ti) => {
    result[originalIndex] = {
      ...result[originalIndex],
      translation: translations[ti] || "",
    };
  });
  return result;
}

// ─── parseAIRes 正则解析 ───

describe("parseAIRes regex parser with real LLM output", () => {
  test("parses standard format with consecutive IDs", () => {
    const raw = JSON.stringify(
      Array.from({ length: 394 }, (_, i) => ({
        id: i,
        text: `译 ${i}`,
      }))
    );

    const result = parseLLMResponse(raw);
    expect(result.length).toBe(394);
    expect(result.filter((t) => t).length).toBe(394);
    expect(result[0]).toBe("译 0");
    expect(result[393]).toBe("译 393");
  });

  test("parses format with optional whitespace", () => {
    const raw =
      '[\n  {"id" : 0 , "text" : "你好"} ,\n  {"id": 1,"text":"世界"}\n]';

    const result = parseLLMResponse(raw);
    expect(result.length).toBe(2);
    expect(result.filter((t) => t).length).toBe(2);
    expect(result[0]).toBe("你好");
    expect(result[1]).toBe("世界");
  });

  test("skips malformed entries and fills gaps", () => {
    // id:1 缺少引号 → 正则会跳过它
    const raw = `[
      {"id":0,"text":"你好"},
      {"id:1,"text":"跳过这条"},
      {"id":2,"text":"世界"}
    ]`;

    const result = parseLLMResponse(raw);
    expect(result.length).toBe(3);
    expect(result[0]).toBe("你好");
    expect(result[1]).toBe(""); // id=1 解析失败，填空
    expect(result[2]).toBe("世界");
  });

  test("handles escaped quotes in text", () => {
    const raw =
      '[{"id":0,"text":"He said \\"hello\\" to me"},{"id":1,"text":"OK"}]';

    const result = parseLLMResponse(raw);
    expect(result.length).toBe(2);
    expect(result[0]).toBe('He said "hello" to me');
    expect(result[1]).toBe("OK");
  });

  test("handles real deepseek response containing Chinese text", () => {
    // 截取自真实日志，含中文、日文、特殊符号
    const raw = `[{"id":0,"text":"艾伦·韦克2是一款令人惊叹的游戏，是本世代迄今为止技术上最出色的游戏之一。"},{"id":1,"text":"但它是一款非常偏向PC的游戏，提供了高级图像构建、路径追踪、"},{"id":2,"text":"RTX Mega Geometry、超高帧率以及其他好东西。"},{"id":3,"text":"但是，PS5 Pro在2024年问世，并带来了PSSR和光线追踪反射。"},{"id":4,"text":"但当然，PSSR并非完全如承诺的那样，我们在那个游戏上遇到了一系列PSSR问题。"},{"id":5,"text":"并非在所有情况下都表现良好"},{"id":35,"text":"[音乐]"},{"id":76,"text":"有何改进？"},{"id":393,"text":"最后一条测试"}]`;

    const result = parseLLMResponse(raw);
    // 最大 id 是 393，所以长度为 394
    expect(result.length).toBe(394);
    // 应该成功解析 9 条
    const filled = result.filter((t) => t);
    expect(filled.length).toBe(9);
    expect(result[0]).toContain("艾伦·韦克");
    expect(result[35]).toBe("[音乐]");
    expect(result[76]).toBe("有何改进？");
    expect(result[393]).toBe("最后一条测试");
    // 跳过的 id 填空
    expect(result[6]).toBe("");
    expect(result[34]).toBe("");
  });

  test("returns empty array on non-JSON text input", () => {
    const raw =
      "发售已经9年了，GTA 5 如今又跳到了全新的主机世代...";

    const result = parseLLMResponse(raw);
    expect(result.length).toBe(0);
  });

  test("handles empty response", () => {
    expect(parseLLMResponse("")).toEqual([]);
    expect(parseLLMResponse(null)).toEqual([]);
    expect(parseLLMResponse(undefined)).toEqual([]);
  });
});

describe("subtitle translation chunks", () => {
  test("splits subtitles into 20, 40, then 80 item chunks with context by default", () => {
    const texts = Array.from({ length: 530 }, (_, id) => `Original ${id}`);
    const chunks = splitSubtitleTranslationChunks(texts, { contextSize: 10 });

    expect(chunks.map((chunk) => chunk.segmentIds)).toEqual([
      Array.from({ length: 20 }, (_, i) => i),
      Array.from({ length: 40 }, (_, i) => i + 20),
      Array.from({ length: 80 }, (_, i) => i + 60),
      Array.from({ length: 80 }, (_, i) => i + 140),
      Array.from({ length: 80 }, (_, i) => i + 220),
      Array.from({ length: 80 }, (_, i) => i + 300),
      Array.from({ length: 80 }, (_, i) => i + 380),
      Array.from({ length: 70 }, (_, i) => i + 460),
    ]);
    expect(chunks[0].contextAfter.map((item) => item.globalIndex)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 20)
    );
    expect(chunks[1].contextBefore.map((item) => item.globalIndex)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 10)
    );
    expect(chunks[1].contextBefore.some((item) => "id" in item)).toBe(false);
    expect(chunks[0].contextAfter.some((item) => "id" in item)).toBe(false);
  });


  test("runs first chunk before launching remaining chunks", async () => {
    const chunks = [{ start: 0 }, { start: 20 }, { start: 60 }];
    const started = [];
    let releaseFirst;
    const firstChunkGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const translateChunk = jest.fn(async (chunk) => {
      started.push(chunk.start);
      if (chunk.start === 0) await firstChunkGate;
      return true;
    });

    const runPromise = runSubtitleChunksFirstThenAll(chunks, translateChunk);
    await Promise.resolve();

    expect(started).toEqual([0]);

    releaseFirst();
    await runPromise;

    expect(started).toEqual([0, 20, 60]);
    expect(translateChunk).toHaveBeenCalledTimes(3);
  });
  test("strict parser accepts only complete JSON object with exact chunk ids", () => {
    const result = parseStrictSubtitleChunkResult(
      '{"items":[{"id":40,"text":"译文40"},{"id":41,"text":"译文41"}]}',
      [40, 41]
    );

    expect(result.ok).toBe(true);
    expect(result.translations).toEqual(["译文40", "译文41"]);
  });

  test("strict parser reports the id when an item text is empty", () => {
    const result = parseStrictSubtitleChunkResult(
      '{"items":[{"id":0,"text":"ok"},{"id":1,"text":""}]}',
      [0, 1]
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("item text must be a non-empty string: id 1");
  });
  test("strict parser rejects missing duplicate extra context and malformed ids", () => {
    expect(
      parseStrictSubtitleChunkResult(
        '{"items":[{"id":40,"text":"译文40"}]}',
        [40, 41]
      ).ok
    ).toBe(false);
    expect(
      parseStrictSubtitleChunkResult(
        '{"items":[{"id":40,"text":"译文40"},{"id":40,"text":"重复"}]}',
        [40, 41]
      ).ok
    ).toBe(false);
    expect(
      parseStrictSubtitleChunkResult(
        '{"items":[{"id":40,"text":"译文40"},{"id":39,"text":"上下文"}]}',
        [40, 41]
      ).ok
    ).toBe(false);
    expect(
      parseStrictSubtitleChunkResult(
        '{"items":[{"id":"40","text":"译文40"},{"id":41,"text":"译文41"}]}',
        [40, 41]
      ).ok
    ).toBe(false);
  });

  test("initial subtitle chunk is ready only after the first 20 text subtitles have translations", () => {
    const subtitles = Array.from({ length: 45 }, (_, i) => ({
      text: `source ${i}`,
      translation: i < 19 ? `translation ${i}` : "",
    }));

    expect(isInitialSubtitleChunkReady(subtitles)).toBe(false);

    subtitles[19].translation = "translation 19";
    expect(isInitialSubtitleChunkReady(subtitles)).toBe(true);
  });
});

describe("subtitle batch API prompt settings", () => {
  test("asks for compact JSON to reduce long-video response size", () => {
    const prompt = buildBatchSubtitleSystemPrompt({
      count: 428,
      toLang: "zh-CN",
    });

    expect(prompt).toContain("compact minified JSON");
    expect(prompt).toContain("no spaces or newlines outside string values");
  });

  test("disables chat history for whole-track retry requests", () => {
    const setting = createBatchSubtitleApiSetting({
      apiSetting: {
        systemPrompt: "old",
        httpTimeout: 1000,
        useStream: true,
        contextChatHistory: true,
        useContext: true,
      },
      isAI: true,
      texts: ["one", "two"],
      toLang: "zh-CN",
      defaultHttpTimeout: 1000,
    });

    expect(setting.contextChatHistory).toBe(false);
    expect(setting.useContext).toBe(false);
    expect(setting.useStream).toBe(false);
  });

  test("strict chunk prompt hard-separates readonly context from translatable segments", () => {
    const prompt = buildStrictChunkSubtitleSystemPrompt({
      count: 2,
      toLang: "zh-CN",
    });

    expect(prompt).toContain("Translate ONLY payload.segmentsToTranslate");
    expect(prompt).toContain("readonlyContext is reference-only");
    expect(prompt).toContain(
      "Never move meaning, words, clauses, or sentence continuations across ids"
    );
  });

  test("batch user prompt isolates context as readonly text blocks", () => {
    const prompt = buildBatchSubtitleUserPrompt({
      useBatchFetch: true,
      toLang: "zh-CN",
      texts: ["current zero", "current one"],
      contextBefore: [
        { globalIndex: 10, text: "before zero" },
        { globalIndex: 11, text: "before one" },
      ],
      contextAfter: [{ globalIndex: 14, text: "after zero" }],
      docInfo: { title: "Video title", description: "Video description" },
    });
    const parsed = JSON.parse(prompt);

    expect(parsed.segments).toBeUndefined();
    expect(parsed.contextBefore).toBeUndefined();
    expect(parsed.contextAfter).toBeUndefined();
    expect(parsed.payload.segmentsToTranslate).toEqual([
      { id: 0, source: "current zero" },
      { id: 1, source: "current one" },
    ]);
    expect(parsed.readonlyContext.beforeText).toBe("before zero\nbefore one");
    expect(parsed.readonlyContext.afterText).toBe("after zero");
  });
});

// ─── 翻译 → 字幕 映射 ───

describe("batch translation → subtitle mapping", () => {
  test("maps translations to correct subtitle indices via textIndices", () => {
    const subtitles = [
      { text: "Hello", start: 0, end: 1000 },
      { text: "World", start: 1000, end: 2000 },
      { text: "", start: 2000, end: 3000 }, // 空字幕
      { text: "Goodbye", start: 3000, end: 4000 },
    ];

    const translations = ["你好", "世界", "再见"]; // 只对应非空字幕

    const result = mapTranslationsToSubtitles(subtitles, translations);

    expect(result[0].translation).toBe("你好");
    expect(result[1].translation).toBe("世界");
    expect(result[2].translation || "").toBe(""); // 空原文 → 翻译保持空
    expect(result[3].translation).toBe("再见");
  });

  test("does not shift mapping when subtitles have leading empty entries", () => {
    const subtitles = [
      { text: "", start: 0, end: 500 },
      { text: "", start: 500, end: 1000 },
      { text: "First", start: 1000, end: 2000 },
      { text: "Second", start: 2000, end: 3000 },
    ];

    const translations = ["第一", "第二"]; // 只对应 textIndices[2], textIndices[3]

    const result = mapTranslationsToSubtitles(subtitles, translations);

    expect(result[0].translation || "").toBe("");
    expect(result[1].translation || "").toBe("");
    expect(result[2].translation).toBe("第一");
    expect(result[3].translation).toBe("第二");
  });

  test("maps correctly with 394 subtitles and 394 translations", () => {
    const subtitles = Array.from({ length: 394 }, (_, i) => ({
      text: `Original ${i}`,
      start: i * 1000,
      end: (i + 1) * 1000,
    }));
    const translations = Array.from({ length: 394 }, (_, i) => `翻译 ${i}`);

    const result = mapTranslationsToSubtitles(subtitles, translations);

    for (let i = 0; i < 394; i++) {
      expect(result[i].translation).toBe(`翻译 ${i}`);
    }
  });

  test("handles translation count mismatch without index shift", () => {
    // 394 条字幕，但 LLM 只返回了 300 条翻译（缺失 94 条）
    const subtitles = Array.from({ length: 394 }, (_, i) => ({
      text: `Original ${i}`,
      start: i * 1000,
      end: (i + 1) * 1000,
    }));
    const translations = Array.from({ length: 300 }, (_, i) => `翻译 ${i}`);
    // 翻译数不够时，textIndices.forEach 不会越界
    // ti 从 0..299，originalIndex 从 0..299 对应 subtitles[0..299]
    // subtitles[300..393] 翻译为空

    const result = mapTranslationsToSubtitles(subtitles, translations);

    for (let i = 0; i < 300; i++) {
      expect(result[i].translation).toBe(`翻译 ${i}`);
    }
    for (let i = 300; i < 394; i++) {
      expect(result[i].translation || "").toBe("");
    }
  });
});

// ─── 覆盖率检测 ───

describe("subtitle translation coverage", () => {
  test("reports in-flight batch translation progress without showing zero", () => {
    expect(getSubtitleTranslationProgress(["A", "B", "C"], null)).toBe(1);
  });

  test("reports partial batch translation coverage capped below complete", () => {
    const texts = Array.from({ length: 1464 }, (_, i) => `Original ${i}`);
    const translations = Array.from({ length: 1159 }, (_, i) => `译文 ${i}`);

    expect(getSubtitleTranslationProgress(texts, translations)).toBe(79);
  });

  test("keeps complete translation progress below 100 until subtitles are ready", () => {
    expect(getSubtitleTranslationProgress(["A", "B"], ["甲", "乙"])).toBe(99);
  });

  test("getMissingSubtitleTranslationIndexes finds untranslated non-empty sources", () => {
    const texts = ["A", "", "C", "D", "E"];
    const translations = ["译A", "", "", "译D"];

    expect(getMissingSubtitleTranslationIndexes(texts, translations)).toEqual([
      2,
      4,
    ]);
  });

  test("isCompleteSubtitleTranslationBatch requires all non-empty sources translated", () => {
    const texts = ["A", "B", "C", "", "E"];
    expect(
      isCompleteSubtitleTranslationBatch(texts, ["译A", "译B", "译C", "", "译E"])
    ).toBe(true);
    expect(
      isCompleteSubtitleTranslationBatch(texts, ["译A", "", "译C", "", "译E"])
    ).toBe(false);
  });

  test("countFilledTranslations counts non-empty strings", () => {
    expect(countFilledTranslations(["你好", "", "世界"])).toBe(2);
    expect(countFilledTranslations([])).toBe(0);
  });

});

// ─── 端到端：从 LLM 回包到 BilingualSubtitleManager 可用数据 ───

describe("end-to-end: LLM response → display-ready subtitles", () => {
  test("complete flow for 394-segment subtitle translation", () => {
    // Step 1: 模拟 YouTube 字幕数据 (#eventsToSubtitles 格式化后)
    const subtitles = Array.from({ length: 394 }, (_, i) => ({
      text: `Subtitle text ${i}`,
      start: i * 1000,
      end: (i + 1) * 1000,
    }));

    // Step 2: 模拟 LLM 回包 (#batchTranslateAll → apiBatchSubtitleTranslate → parseAIRes)
    const llmRawResponse = JSON.stringify(
      subtitles.map((s, i) => ({
        id: i,
        text: `译文 ${i}`,
      }))
    );
    const parsed = parseLLMResponse(llmRawResponse);

    // 验证解析完整性
    expect(parsed.length).toBe(394);
    expect(countFilledTranslations(parsed)).toBe(394);

    // Step 3: 回填到字幕 (#batchTranslateAll mapping)
    const result = mapTranslationsToSubtitles(subtitles, parsed);

    // Step 4: 验证每条字幕的翻译正确（BilingualSubtitleManager 直接读取 subtitle.translation）
    for (let i = 0; i < 394; i++) {
      expect(result[i].translation).toBe(`译文 ${i}`);
    }
  });

  test("handles LLM response with partial failures", () => {
    // 394 条字幕，LLM 返回 350 条翻译（缺 44 条），且格式正确
    const subtitles = Array.from({ length: 394 }, (_, i) => ({
      text: `Subtitle ${i}`,
      start: i * 1000,
      end: (i + 1) * 1000,
    }));

    const partialResponse = JSON.stringify(
      Array.from({ length: 350 }, (_, i) => ({
        id: i,
        text: `译文 ${i}`,
      }))
    );

    const parsed = parseLLMResponse(partialResponse);
    expect(parsed.length).toBe(350); // maxId=349, length=350
    expect(countFilledTranslations(parsed)).toBe(350);

    const result = mapTranslationsToSubtitles(subtitles, parsed);

    // 前 350 条翻译正确
    for (let i = 0; i < 350; i++) {
      expect(result[i].translation).toBe(`译文 ${i}`);
    }
    // 后 44 条翻译为空
    for (let i = 350; i < 394; i++) {
      expect(result[i].translation || "").toBe("");
    }
  });
});
