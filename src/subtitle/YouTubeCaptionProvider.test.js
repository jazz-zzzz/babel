process.env.REACT_APP_NAME = process.env.REACT_APP_NAME || "Babel";
process.env.REACT_APP_VERSION = process.env.REACT_APP_VERSION || "2.0.21";

jest.mock("../apis/index.js", () => ({
  apiBatchSubtitleTranslate: jest.fn(),
}));

jest.mock("../apis/history.js", () => ({
  clearMsgHistory: jest.fn(),
}));

jest.mock("../config", () => ({
  MSG_XHR_DATA_BABEL: "BABEL_XHR_DATA_YOUTUBE",
  APP_NAME: "Babel",
  OPT_LANGS_TO_CODE: {
    microsoft: new Map(),
  },
  OPT_TRANS_MICROSOFT: "microsoft",
  OPT_LANGS_SPEC_DEFAULT: new Map(),
  newI18n: jest.fn(() => (key) => key),
}));

jest.mock("../libs/log.js", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../libs/domManager.js", () => jest.fn());
jest.mock("./BilingualSubtitleManager.js", () => ({
  BilingualSubtitleManager: jest.fn(),
}));
jest.mock("./YouTubeSubtitleList.js", () => ({
  YouTubeSubtitleList: jest.fn(),
}));
jest.mock("./Menus.js", () => ({
  Menus: jest.fn(),
}));
jest.mock("./sentenceBreaker.js", () => ({
  intelligentSentenceBreak: jest.fn(),
}));

const {
  extractOriginalSubtitleEventsFromTimedtextResponse,
} = require("./YouTubeCaptionProvider");

describe("extractOriginalSubtitleEventsFromTimedtextResponse", () => {
  test("uses intercepted original timedtext JSON without another network lookup", () => {
    const events = [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hi" }] }];
    const result = extractOriginalSubtitleEventsFromTimedtextResponse({
      url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&fmt=json3",
      responseText: JSON.stringify({ events }),
    });

    expect(result).toEqual(events);
  });

  test("does not use translated timedtext responses as original subtitles", () => {
    const result = extractOriginalSubtitleEventsFromTimedtextResponse({
      url: "https://www.youtube.com/api/timedtext?v=abc&lang=en&tlang=zh-CN&fmt=json3",
      responseText: JSON.stringify({ events: [{ tStartMs: 0 }] }),
    });

    expect(result).toBeNull();
  });
});
