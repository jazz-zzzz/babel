const mockGetFetchPool = jest.fn(() => ({
  push: jest.fn(async () => "ok"),
}));

jest.mock("./pool", () => ({
  __esModule: true,
  getFetchPool: mockGetFetchPool,
}));

jest.mock("../config", () => ({
  MSG_FETCH: "fetch",
  DEFAULT_HTTP_TIMEOUT: 10000,
  PORT_STREAM_FETCH: "stream-fetch",
}));

jest.mock("./cache", () => ({
  getHttpCachePolyfill: jest.fn(),
  parseResponse: jest.fn(),
}));

jest.mock("./client", () => ({
  isExt: false,
  isGm: false,
}));

jest.mock("./msg", () => ({
  sendBgMsg: jest.fn(),
}));

jest.mock("./storage", () => ({
  getSettingWithDefault: jest.fn(),
}));

jest.mock("./browser", () => ({
  isBg: jest.fn(() => false),
}));

jest.mock("./log", () => ({
  babelLog: jest.fn(),
}));

jest.mock("./stream", () => ({
  createSSEParser: jest.fn(() => function* noop() {}),
  createAsyncQueue: jest.fn(() => ({
    push: jest.fn(),
    finish: jest.fn(),
    error: jest.fn(),
    iterate: jest.fn(() => []),
  })),
}));

jest.mock("webextension-polyfill", () => ({
  runtime: {
    connect: jest.fn(),
  },
}));

const { fetchData } = require("./fetch");

describe("fetchData pool routing", () => {
  beforeEach(() => {
    mockGetFetchPool.mockImplementation(() => ({
      push: jest.fn(async () => "ok"),
    }));
  });

  test("passes poolKey to the fetch pool", async () => {
    await fetchData(
      "https://example.test",
      {},
      {
        usePool: true,
        fetchInterval: 10,
        fetchLimit: 30,
        poolKey: "subtitle",
      }
    );

    expect(mockGetFetchPool).toHaveBeenCalledWith(10, 30, "subtitle");
  });
});
