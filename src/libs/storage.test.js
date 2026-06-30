function loadStorageModule() {
  jest.resetModules();
  process.env.REACT_APP_NAME = "Babel";
  process.env.REACT_APP_VERSION = "2.0.21";
  process.env.REACT_APP_CLIENT = "web";
  process.env.REACT_APP_RULESURL = "https://example.com/babel-rules.json";

  return {
    storageModule: require("./storage"),
    config: require("../config"),
  };
}

function legacyNamespace() {
  return ["KISS", "Translator"].join("-");
}

describe("storage migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("restores settings from the pre-rename storage key before writing defaults", async () => {
    const legacySetting = {
      uiLang: "zh-CN",
      subtitleSetting: {
        enabled: true,
        windowStyle: "padding: 9px; background-color: rgba(1, 2, 3, 0.7);",
        originStyle: "font-size: 22px; color: #abcdef;",
        translationStyle: "font-size: 24px; color: #fedcba;",
      },
    };

    window.localStorage.setItem(
      `${legacyNamespace()}_setting_v2`,
      JSON.stringify(legacySetting)
    );

    const {
      storageModule: { getSetting, tryInitDefaultData },
      config: { STOKEY_SETTING },
    } = loadStorageModule();

    await tryInitDefaultData("en");

    expect(await getSetting()).toEqual(legacySetting);
    expect(JSON.parse(window.localStorage.getItem(STOKEY_SETTING))).toEqual(
      legacySetting
    );
  });

  test("applies DeepSeek speed defaults when reading stored settings with old API defaults", async () => {
    const {
      storageModule: { getSettingWithDefault },
      config: { DEFAULT_API_LIST, OPT_TRANS_DEEPSEEK, STOKEY_SETTING },
    } = loadStorageModule();

    const oldApis = DEFAULT_API_LIST.map((api) =>
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

    window.localStorage.setItem(
      STOKEY_SETTING,
      JSON.stringify({
        uiLang: "zh-CN",
        transApis: oldApis,
      })
    );

    const setting = await getSettingWithDefault();
    const deepSeek = setting.transApis.find(
      (api) => api.apiType === OPT_TRANS_DEEPSEEK
    );

    expect(deepSeek).toMatchObject({
      useStream: true,
      streamRenderMode: "segment",
      thinkingMode: "disabled",
      batchInterval: 50,
      fetchInterval: 10,
      rootMargin: 2000,
    });
  });
});
