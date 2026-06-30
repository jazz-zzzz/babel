process.env.REACT_APP_NAME = process.env.REACT_APP_NAME || "Babel";
process.env.REACT_APP_VERSION = process.env.REACT_APP_VERSION || "2.0.21";

jest.mock("../apis/index.js", () => ({
  apiMicrosoftDict: jest.fn(),
}));

const { BilingualSubtitleManager } = require("./BilingualSubtitleManager");

function createVideoFixture() {
  document.body.innerHTML = `
    <div class="html5-video-player">
      <div class="video-shell">
        <div class="video-inner">
          <video></video>
        </div>
      </div>
      <div class="ytp-left-controls" style="height: 48px;"></div>
    </div>
  `;

  const videoEl = document.querySelector("video");
  Object.defineProperty(videoEl, "paused", {
    configurable: true,
    value: false,
  });
  videoEl.pause = jest.fn(() => {
    Object.defineProperty(videoEl, "paused", {
      configurable: true,
      value: true,
    });
  });
  videoEl.play = jest.fn(() => {
    Object.defineProperty(videoEl, "paused", {
      configurable: true,
      value: false,
    });
  });

  return videoEl;
}

function createManager(videoEl, settingOverrides = {}) {
  return new BilingualSubtitleManager({
    videoEl,
    formattedSubtitles: [
      {
        start: 0,
        end: 10_000,
        text: "Hello world",
        translation: "你好，世界",
      },
    ],
    setting: {
      hoverLookupMode: "off",
      pauseOnSubtitleHover: false,
      windowStyle: "",
      originStyle: "",
      translationStyle: "",
      isBilingual: true,
      fromLang: "en",
      toLang: "zh-CN",
      apiSetting: {},
      docInfo: {},
      ...settingOverrides,
    },
  });
}

describe("BilingualSubtitleManager", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
  });

  test("does not pause playback when hovering translated subtitles", () => {
    const videoEl = createVideoFixture();
    const manager = createManager(videoEl);

    manager.start();

    const captionWindow = document.querySelector(".babel-caption-window");
    captionWindow.dispatchEvent(new Event("pointerenter", { bubbles: true }));

    expect(videoEl.pause).not.toHaveBeenCalled();

    manager.destroy();
  });

  test("pauses playback on subtitle hover when pause setting is enabled", () => {
    const videoEl = createVideoFixture();
    const manager = createManager(videoEl, {
      hoverLookupMode: "off",
      pauseOnSubtitleHover: true,
    });

    manager.start();

    const captionWindow = document.querySelector(".babel-caption-window");
    captionWindow.dispatchEvent(new Event("pointerenter", { bubbles: true }));

    expect(videoEl.pause).toHaveBeenCalledTimes(1);
    expect(videoEl.play).not.toHaveBeenCalled();

    captionWindow.dispatchEvent(new Event("pointerleave", { bubbles: true }));

    expect(videoEl.play).toHaveBeenCalledTimes(1);

    manager.destroy();
  });
});
