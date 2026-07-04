describe("DeepSeek speed defaults", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("ships DeepSeek with low-latency defaults", () => {
    const { DEFAULT_API_LIST, OPT_TRANS_DEEPSEEK } = require("./api");

    const deepSeek = DEFAULT_API_LIST.find(
      (api) => api.apiType === OPT_TRANS_DEEPSEEK
    );

    expect(deepSeek).toMatchObject({
      useBatchFetch: true,
      useStream: true,
      streamRenderMode: "segment",
      thinkingMode: "disabled",
      batchInterval: 50,
      fetchLimit: 30,
      fetchInterval: 10,
      rootMargin: 2000,
    });
  });

  test("upgrades stored DeepSeek entries that still use old latency defaults", () => {
    const {
      DEFAULT_API_LIST,
      normalizeTransApisForRuntime,
      OPT_TRANS_DEEPSEEK,
    } = require("./api");

    const storedApis = DEFAULT_API_LIST.map((api) =>
      api.apiType === OPT_TRANS_DEEPSEEK
        ? {
            ...api,
            useStream: false,
            streamRenderMode: "disabled",
            thinkingMode: "auto",
            batchInterval: 400,
            fetchInterval: 100,
            rootMargin: 500,
          }
        : api
    );

    const normalized = normalizeTransApisForRuntime(storedApis);
    const deepSeek = normalized.find(
      (api) => api.apiType === OPT_TRANS_DEEPSEEK
    );

    expect(deepSeek).toMatchObject({
      useStream: true,
      streamRenderMode: "segment",
      thinkingMode: "disabled",
      batchInterval: 50,
      fetchLimit: 30,
      fetchInterval: 10,
      rootMargin: 2000,
    });
  });

  test("keeps customized DeepSeek speed settings untouched", () => {
    const {
      DEFAULT_API_LIST,
      normalizeTransApisForRuntime,
      OPT_TRANS_DEEPSEEK,
    } = require("./api");

    const storedApis = DEFAULT_API_LIST.map((api) =>
      api.apiType === OPT_TRANS_DEEPSEEK
        ? {
            ...api,
            useStream: false,
            streamRenderMode: "disabled",
            thinkingMode: "auto",
            batchInterval: 250,
            fetchInterval: 80,
            rootMargin: 1200,
          }
        : api
    );

    const normalized = normalizeTransApisForRuntime(storedApis);
    const deepSeek = normalized.find(
      (api) => api.apiType === OPT_TRANS_DEEPSEEK
    );

    expect(deepSeek).toMatchObject({
      useStream: false,
      streamRenderMode: "disabled",
      thinkingMode: "disabled",
      thinkingEffort: "_default",
      batchInterval: 250,
      fetchInterval: 80,
      rootMargin: 1200,
    });
  });

  test("forces thinking disabled only for stored DeepSeek runtime APIs", () => {
    const {
      DEFAULT_API_LIST,
      normalizeTransApisForRuntime,
      OPT_TRANS_DEEPSEEK,
      OPT_TRANS_OPENAI,
    } = require("./api");

    const storedApis = DEFAULT_API_LIST.map((api) => {
      if (api.apiType === OPT_TRANS_DEEPSEEK) {
        return {
          ...api,
          thinkingMode: "enabled",
          thinkingEffort: "max",
        };
      }
      if (api.apiType === OPT_TRANS_OPENAI) {
        return {
          ...api,
          thinkingMode: "auto",
          thinkingEffort: "high",
        };
      }
      return api;
    });

    const normalized = normalizeTransApisForRuntime(storedApis);

    expect(
      normalized.find((api) => api.apiType === OPT_TRANS_DEEPSEEK)
    ).toMatchObject({
      thinkingMode: "disabled",
      thinkingEffort: "_default",
    });
    expect(
      normalized.find((api) => api.apiType === OPT_TRANS_OPENAI)
    ).toMatchObject({
      thinkingMode: "auto",
      thinkingEffort: "high",
    });
  });

  test("does not ship non-DeepSeek APIs with forced thinking disabled", () => {
    const { DEFAULT_API_LIST, OPT_TRANS_OPENAI } = require("./api");

    const openAI = DEFAULT_API_LIST.find(
      (api) => api.apiType === OPT_TRANS_OPENAI
    );

    expect(openAI.thinkingMode).toBe("auto");
    expect(openAI.thinkingEffort).toBe("_default");
  });
});
