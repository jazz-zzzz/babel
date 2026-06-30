const https = require("https");
const { URL } = require("url");
const {
  buildBatchSubtitleSystemPrompt,
  buildStrictChunkSubtitleSystemPrompt,
  parseStrictSubtitleChunkResult,
  splitSubtitleTranslationChunks,
} = require("./subtitleBatch");

const RUN_BENCHMARK = process.env.RUN_DEEPSEEK_BENCHMARK === "1";
const testMaybe = RUN_BENCHMARK ? test : test.skip;

jest.setTimeout(Number(process.env.DEEPSEEK_BENCHMARK_TIMEOUT_MS || 600000));

const sampleLines = [
  "So I want to start by offering you a free no-tech life hack.",
  "All it requires of you is that you change your posture for two minutes.",
  "Before I give it away, I want to ask you to audit your body.",
  "We are fascinated with body language and nonverbal behavior.",
  "These judgments can predict meaningful life outcomes.",
  "We are also influenced by our own nonverbals.",
  "Powerful people tend to be more assertive and confident.",
  "Tiny tweaks can lead to big changes.",
  "Configure your brain to cope better in stressful situations.",
  "Thank you very much.",
];

const makeSegments = (count) =>
  Array.from({ length: count }, (_, id) => ({
    id,
    text: sampleLines[id % sampleLines.length],
  }));

const postJson = (url, apiKey, body) =>
  new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const payload = JSON.stringify(body);
    const startedAt = Date.now();
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({
            elapsedMs: Date.now() - startedAt,
            statusCode: res.statusCode,
            raw,
            json,
          });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

const deepseekConfig = () => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Set DEEPSEEK_API_KEY to run this benchmark.");
  }

  return {
    apiKey,
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    url:
      process.env.DEEPSEEK_BASE_URL ||
      "https://api.deepseek.com/chat/completions",
    maxTokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 32768),
    thinkingMode: process.env.DEEPSEEK_THINKING_MODE || "disabled",
  };
};

const addThinking = (body, thinkingMode) => {
  if (thinkingMode !== "auto") {
    body.thinking = { type: thinkingMode };
  }
  return body;
};

const makeChunkRequestBody = ({ chunk, model, maxTokens, thinkingMode }) =>
  addThinking(
    {
      model,
      messages: [
        {
          role: "system",
          content: buildStrictChunkSubtitleSystemPrompt({
            count: chunk.texts.length,
            toLang: "zh-CN",
          }),
        },
        {
          role: "user",
          content: JSON.stringify({
            targetLanguage: "zh-CN",
            segments: chunk.texts.map((text, id) => ({ id, text })),
            contextBefore: chunk.contextBefore,
            contextAfter: chunk.contextAfter,
          }),
        },
      ],
      temperature: 0.1,
      max_tokens: Number(process.env.DEEPSEEK_CHUNK_MAX_TOKENS || Math.max(2048, chunk.texts.length * 80)),
      stream: false,
      response_format: { type: "json_object" },
    },
    thinkingMode
  );

const translateChunkOnce = async ({ chunk, config }) => {
  const result = await postJson(
    config.url,
    config.apiKey,
    makeChunkRequestBody({
      chunk,
      model: config.model,
      maxTokens: config.maxTokens,
      thinkingMode: config.thinkingMode,
    })
  );
  const content = result.json?.choices?.[0]?.message?.content || "";
  const parsed = parseStrictSubtitleChunkResult(
    content,
    Array.from({ length: chunk.texts.length }, (_, id) => id)
  );
  return {
    start: chunk.start,
    end: chunk.end,
    count: chunk.texts.length,
    statusCode: result.statusCode,
    elapsedMs: result.elapsedMs,
    ok: result.statusCode >= 200 && result.statusCode < 300 && parsed.ok,
    parseError: parsed.ok ? null : parsed.error,
    finishReason: result.json?.choices?.[0]?.finish_reason || null,
    usage: result.json?.usage || null,
  };
};

const runLimited = async ({ chunks, config, concurrency }) => {
  let next = 0;
  const results = [];
  const workers = Array.from(
    { length: Math.min(concurrency, chunks.length) },
    async () => {
      while (next < chunks.length) {
        const chunk = chunks[next];
        next += 1;
        results.push(await translateChunkOnce({ chunk, config }));
      }
    }
  );
  await Promise.all(workers);
  return results.sort((a, b) => a.start - b.start);
};

const runFirstThenAll = async ({ chunks, config }) => {
  if (!chunks.length) return [];
  const first = await translateChunkOnce({ chunk: chunks[0], config });
  const rest = await Promise.all(
    chunks.slice(1).map((chunk) => translateChunkOnce({ chunk, config }))
  );
  return [first, ...rest].sort((a, b) => a.start - b.start);
};

testMaybe("benchmarks real DeepSeek whole-subtitle translation latency", async () => {
  const config = deepseekConfig();
  const count = Number(process.env.DEEPSEEK_BENCHMARK_SEGMENTS || 428);
  const nonce = process.env.DEEPSEEK_BENCHMARK_NONCE || "";
  const segments = makeSegments(count);
  if (nonce && segments[0]) {
    segments[0] = {
      ...segments[0],
      text: `${segments[0].text} Benchmark nonce: ${nonce}.`,
    };
  }
  const promptObject = {
    targetLanguage: "zh-CN",
    segments,
  };
  const userPrompt = JSON.stringify(promptObject);

  const requestBody = addThinking(
    {
      model: config.model,
      messages: [
        {
          role: "system",
          content: buildBatchSubtitleSystemPrompt({ count, toLang: "zh-CN" }),
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.1,
      max_tokens: config.maxTokens,
      stream: false,
    },
    config.thinkingMode
  );

  const result = await postJson(config.url, config.apiKey, requestBody);
  const content = result.json?.choices?.[0]?.message?.content || "";
  const finishReason = result.json?.choices?.[0]?.finish_reason || null;
  const matchedIds = new Set(
    [...content.matchAll(/\{\s*"id"\s*:\s*(\d+)\s*,\s*"text"\s*:/g)].map(
      (match) => Number(match[1])
    )
  );

  console.log(
    JSON.stringify(
      {
        model: config.model,
        count,
        thinkingMode: config.thinkingMode,
        promptCacheMode: nonce ? "nonce" : "default",
        statusCode: result.statusCode,
        elapsedMs: result.elapsedMs,
        elapsedSeconds: Number((result.elapsedMs / 1000).toFixed(2)),
        inputChars: userPrompt.length,
        outputChars: content.length,
        matchedCount: matchedIds.size,
        finishReason,
        usage: result.json?.usage || null,
      },
      null,
      2
    )
  );

  expect(result.statusCode).toBeGreaterThanOrEqual(200);
  expect(result.statusCode).toBeLessThan(300);
  expect(content).toBeTruthy();
});

testMaybe("benchmarks real DeepSeek chunk scheduling strategies", async () => {
  const config = deepseekConfig();
  const count = Number(process.env.DEEPSEEK_BENCHMARK_SEGMENTS || 428);
  const firstChunkSize = Number(process.env.DEEPSEEK_FIRST_CHUNK_SIZE || 20);
  const secondChunkSize = Number(process.env.DEEPSEEK_SECOND_CHUNK_SIZE || 40);
  const chunkSize = Number(process.env.DEEPSEEK_CHUNK_SIZE || 80);
  const contextSize = Number(process.env.DEEPSEEK_CONTEXT_SIZE || 10);
  const concurrency = Number(process.env.DEEPSEEK_CHUNK_CONCURRENCY || 3);
  const strategy = process.env.DEEPSEEK_CHUNK_STRATEGY || "limited";
  const texts = makeSegments(count).map((segment) => segment.text);
  const chunks = splitSubtitleTranslationChunks(texts, {
    firstChunkSize,
    secondChunkSize,
    chunkSize,
    contextSize,
  });

  const startedAt = Date.now();
  const results =
    strategy === "first-then-all"
      ? await runFirstThenAll({ chunks, config })
      : await runLimited({ chunks, config, concurrency });
  const elapsedMs = Date.now() - startedAt;
  const firstChunk = results.find((item) => item.start === 0);
  const failed = results.filter((item) => !item.ok);

  console.log(
    JSON.stringify(
      {
        model: config.model,
        strategy,
        count,
        chunkShape: { firstChunkSize, secondChunkSize, chunkSize, contextSize },
        concurrency: strategy === "first-then-all" ? "all-after-first" : concurrency,
        chunks: chunks.length,
        elapsedMs,
        elapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
        firstChunkElapsedMs: firstChunk?.elapsedMs ?? null,
        firstChunkSeconds: firstChunk
          ? Number((firstChunk.elapsedMs / 1000).toFixed(2))
          : null,
        okChunks: results.length - failed.length,
        failedChunks: failed.map(({ start, end, statusCode, parseError }) => ({
          start,
          end,
          statusCode,
          parseError,
        })),
        chunkResults: results.map(({ start, end, count, statusCode, elapsedMs, ok }) => ({
          start,
          end,
          count,
          statusCode,
          elapsedMs,
          seconds: Number((elapsedMs / 1000).toFixed(2)),
          ok,
        })),
      },
      null,
      2
    )
  );

  expect(results.length).toBe(chunks.length);
  expect(failed).toHaveLength(0);
});