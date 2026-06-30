describe("sendBgMsg", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("swallows extension context invalidated errors", async () => {
    jest.doMock("./browser", () => ({
      browser: {
        runtime: {
          sendMessage: jest.fn(() =>
            Promise.reject(new Error("Extension context invalidated."))
          ),
        },
      },
    }));

    const { sendBgMsg } = require("./msg");

    await expect(sendBgMsg("TEST_ACTION")).resolves.toBeUndefined();
  });

  test("keeps unexpected background message errors visible", async () => {
    jest.doMock("./browser", () => ({
      browser: {
        runtime: {
          sendMessage: jest.fn(() => Promise.reject(new Error("boom"))),
        },
      },
    }));

    const { sendBgMsg } = require("./msg");

    await expect(sendBgMsg("TEST_ACTION")).rejects.toThrow("boom");
  });
});
