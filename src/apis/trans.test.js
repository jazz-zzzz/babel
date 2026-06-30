jest.mock("query-string", () => ({
  stringify: (obj) => new URLSearchParams(obj).toString(),
}));

jest.mock("../libs/auth", () => ({
  msAuth: jest.fn(),
}));

jest.mock("../libs/fetch", () => ({
  fetchData: jest.fn(),
  fetchStream: jest.fn(),
}));

jest.mock("../libs/stream", () => ({
  parseStreamingSegments: jest.fn(),
  createStreamingJsonParser: jest.fn(() => ({
    write: jest.fn(function* () {}),
    end: jest.fn(),
  })),
  createRealtimeStreamParser: jest.fn(() => ({
    write: jest.fn(() => []),
  })),
  detectStreamFormat: jest.fn(() => ({ isJson: false, detected: false })),
  getStreamDelta: jest.fn(),
}));

describe("DeepSeek request generation", () => {
  test("uses DeepSeek-compatible max_tokens for output budget", async () => {
    const { OPT_TRANS_DEEPSEEK, OPT_LANGS_SPEC_DEFAULT } = require("../config");
    const { genTransReq } = require("./trans");

    const [, init] = await genTransReq({
      apiType: OPT_TRANS_DEEPSEEK,
      apiSlug: OPT_TRANS_DEEPSEEK,
      url: "https://api.deepseek.com/chat/completions",
      key: "test-key",
      model: "deepseek-v4-flash",
      systemPrompt: "Translate.",
      userPrompt: "Hello",
      temperature: 0.1,
      maxTokens: 32768,
      texts: ["Hello"],
      from: "English",
      to: "Chinese (Simplified)",
      fromLang: "en",
      toLang: "zh-CN",
      langMap: OPT_LANGS_SPEC_DEFAULT,
      useBatchFetch: true,
      useStream: false,
    });

    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(32768);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  test("passes response_format through for strict chunk JSON output", async () => {
    const { OPT_TRANS_DEEPSEEK, OPT_LANGS_SPEC_DEFAULT } = require("../config");
    const { genTransReq } = require("./trans");

    const [, init] = await genTransReq({
      apiType: OPT_TRANS_DEEPSEEK,
      apiSlug: OPT_TRANS_DEEPSEEK,
      url: "https://api.deepseek.com/chat/completions",
      key: "test-key",
      model: "deepseek-v4-flash",
      systemPrompt: "Translate.",
      userPrompt: "Hello",
      temperature: 0.1,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
      texts: ["Hello"],
      from: "English",
      to: "Chinese (Simplified)",
      fromLang: "en",
      toLang: "zh-CN",
      langMap: OPT_LANGS_SPEC_DEFAULT,
      useBatchFetch: true,
      useStream: false,
    });

    const body = JSON.parse(init.body);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("strict chunk parsing rejects anything except exact items ids", async () => {
    const { OPT_TRANS_DEEPSEEK, OPT_LANGS_SPEC_DEFAULT } = require("../config");
    const { parseTransRes } = require("./trans");

    await expect(
      parseTransRes(
        {
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"items":[{"id":40,"text":"译文40"},{"id":41,"text":"译文41"}]}',
              },
            },
          ],
        },
        {
          apiType: OPT_TRANS_DEEPSEEK,
          texts: ["A", "B"],
          from: "English",
          to: "Chinese (Simplified)",
          fromLang: "en",
          toLang: "zh-CN",
          langMap: OPT_LANGS_SPEC_DEFAULT,
          useBatchFetch: true,
          strictBatchFetch: true,
          expectedBatchIds: [40, 41],
        }
      )
    ).resolves.toEqual([["译文40", ""], ["译文41", ""]]);

    await expect(
      parseTransRes(
        {
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"items":[{"id":40,"text":"译文40"},{"id":39,"text":"上下文"}]}',
              },
            },
          ],
        },
        {
          apiType: OPT_TRANS_DEEPSEEK,
          texts: ["A", "B"],
          from: "English",
          to: "Chinese (Simplified)",
          fromLang: "en",
          toLang: "zh-CN",
          langMap: OPT_LANGS_SPEC_DEFAULT,
          useBatchFetch: true,
          strictBatchFetch: true,
          expectedBatchIds: [40, 41],
        }
      )
    ).rejects.toThrow("Strict batch parse failed");
  });
});
