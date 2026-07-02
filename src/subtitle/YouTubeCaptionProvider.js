import { logger } from "../libs/log.js";
import { apiBatchSubtitleTranslate } from "../apis/index.js";
import {
  countFilledTranslations,
  getSubtitleTranslationProgress,
  isInitialSubtitleChunkReady,
  runSubtitleChunksFirstThenAll,
  splitSubtitleTranslationChunks,
} from "../apis/subtitleBatch.js";
import { BilingualSubtitleManager } from "./BilingualSubtitleManager.js";
import { YouTubeSubtitleList } from "./YouTubeSubtitleList.js";
import {
  MSG_XHR_DATA_BABEL,
  APP_NAME,
  OPT_LANGS_TO_CODE,
  OPT_TRANS_MICROSOFT,
  OPT_LANGS_SPEC_DEFAULT,
} from "../config";
import { downloadBlobFile } from "../libs/utils.js";
import { createLogoSVG } from "../libs/svg.js";

import { newI18n } from "../config";
import DomManager from "../libs/domManager.js";
import { Menus } from "./Menus.js";
import { buildBilingualVtt } from "./vtt.js";
import { getDocInfo } from "../libs/docInfo.js";
import { intelligentSentenceBreak } from "./sentenceBreaker.js";
import { isSubtitleModeEnabled } from "./modes.js";
import { clearMsgHistory } from "../apis/history.js";

const VIDEO_SELECT = "#container video";
const CONTORLS_SELECT = ".ytp-right-controls";
const YT_CAPTION_SELECT = "#ytp-caption-window-container";
const YT_AD_SELECT = ".video-ads";
const YT_SUBTITLE_BTN_SELECT = "button.ytp-subtitles-button";

export const extractOriginalSubtitleEventsFromTimedtextResponse = ({
  url,
  responseText,
}) => {
  try {
    const timedtextUrl = new URL(url);
    if (timedtextUrl.searchParams.get("tlang")) return null;
    if (!timedtextUrl.searchParams.get("lang")) return null;
    if (/chat/i.test(timedtextUrl.searchParams.get("name") || "")) return null;

    const json = JSON.parse(responseText);
    return Array.isArray(json?.events) && json.events.length
      ? json.events
      : null;
  } catch (err) {
    return null;
  }
};

class YouTubeCaptionProvider {
  #setting = {};

  #subtitles = [];
  #events = [];
  #flatEvents = [];
  #progressedNum = 0;
  #fromLang = "auto";
  #docInfo = {};
  #interceptedCaptionKind = null;

  #processingId = null;
  #processingVersion = 0;
  #activeTrackKey = null;

  #managerInstance = null;
  #toggleButton = null;
  #isMenuShow = false;
  #notificationEl = null;
  #notificationTimeout = null;
  #i18n = () => "";
  #menuManager = null; // 菜单管理器实例
  #ytSubtitleStateObserver = null;

  // 新增：字幕列表管理器实例
  #subtitleListManager = null;

  #activeAbortController = null;
  #pauseRequested = false;

  constructor(setting = {}) {
    this.#setting = { ...setting, showOrigin: false };
    this.#i18n = newI18n(setting.uiLang || "zh");
  }

  get #videoId() {
    const docUrl = new URL(document.location.href);
    return docUrl.searchParams.get("v");
  }

  get #videoEl() {
    return document.querySelector(VIDEO_SELECT);
  }

  set #progressed(num) {
    this.#progressedNum = num;
    this.#updateMenuProps(); // 更新菜单 props
  }

  get #progressed() {
    return this.#progressedNum;
  }

  initialize() {
    window.addEventListener("message", (event) => {
      if (event.data?.type === MSG_XHR_DATA_BABEL) {
        const { url, response } = event.data;
        if (url && response) {
          this.#handleInterceptedRequest(url, response);
        }
      }
    });

    window.addEventListener("yt-navigate-finish", () => {
      logger.debug("Youtube Provider: yt-navigate-finish", this.#videoId);

      this.#destroyManager();
      clearMsgHistory(this.#setting.apiSlug);
      this.#activeAbortController?.abort();
      this.#activeAbortController = null;

      this.#subtitles = [];
      this.#events = [];
      this.#flatEvents = [];
      this.#progressed = 0;
      this.#fromLang = "auto";
      this.#docInfo = {};
      this.#interceptedCaptionKind = null;
      this.#processingId = null;
      this.#processingVersion += 1;
      this.#activeTrackKey = null;
      this.#updateMenuProps(); // 更新菜单 props
    });

    this.#waitForElement(CONTORLS_SELECT, (ytControls) => {
      const ytSubtitleBtn = ytControls.querySelector(YT_SUBTITLE_BTN_SELECT);
      if (ytSubtitleBtn) {
        this.#observeYtSubtitleState(ytSubtitleBtn);
      }

      this.#injectToggleButton(ytControls);
    });

    this.#waitForElement(YT_AD_SELECT, (adContainer) => {
      this.#moAds(adContainer);
    });
  }

  #observeYtSubtitleState(ytSubtitleBtn) {
    this.#ytSubtitleStateObserver?.disconnect();
    this.#ytSubtitleStateObserver = new MutationObserver(() => {
      this.#syncYtSubtitleState(ytSubtitleBtn);
    });
    this.#ytSubtitleStateObserver.observe(ytSubtitleBtn, {
      attributes: true,
      attributeFilter: ["aria-pressed"],
    });
    this.#syncYtSubtitleState(ytSubtitleBtn);
  }

  #syncYtSubtitleState(ytSubtitleBtn) {
    if (ytSubtitleBtn.getAttribute("aria-pressed") === "true") {
      this.#startManager();
    } else {
      this.#destroyManager();
    }
  }

  #isYtSubtitleEnabled() {
    const ytSubtitleBtn = document.querySelector(YT_SUBTITLE_BTN_SELECT);
    return (
      !ytSubtitleBtn || ytSubtitleBtn.getAttribute("aria-pressed") === "true"
    );
  }

  #moAds(adContainer) {
    const adLayoutSelector = ".ytp-ad-player-overlay-layout";
    const skipBtnSelector =
      ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern";
    const observer = new MutationObserver((mutations) => {
      const { skipAd = false } = this.#setting;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          const videoEl = this.#videoEl;
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            if (node.matches(adLayoutSelector)) {
              logger.debug("Youtube Provider: AD start playing!", node);
              // todo: 顺带把广告快速跳过
              if (videoEl && skipAd) {
                videoEl.playbackRate = 16;
                videoEl.currentTime = videoEl.duration;
              }
              if (this.#managerInstance) {
                this.#managerInstance.setIsAdPlaying(true);
              }
            } else if (node.matches(skipBtnSelector) && skipAd) {
              logger.debug("Youtube Provider: AD skip button!", node);
              node.click();
            }

            if (skipAd) {
              const skipBtn = node?.querySelector(skipBtnSelector);
              if (skipBtn) {
                logger.debug("Youtube Provider: AD skip button!!", skipBtn);
                skipBtn.click();
              }
            }
          });
          mutation.removedNodes.forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            if (node.matches(adLayoutSelector)) {
              logger.debug("Youtube Provider: Ad ends!");

              if (!this.#setting.showOrigin) {
                this.#hideYtCaption();
              }
              if (videoEl && skipAd) {
                videoEl.playbackRate = 1;
              }
              if (this.#managerInstance) {
                this.#managerInstance.setIsAdPlaying(false);
              }
            }
          });
        }
      }
    });

    observer.observe(adContainer, {
      childList: true,
      subtree: true,
    });
  }

  #waitForElement(selector, callback) {
    const element = document.querySelector(selector);
    if (element) {
      callback(element);
      return;
    }

    const observer = new MutationObserver((mutations, obs) => {
      const targetNode = document.querySelector(selector);
      if (targetNode) {
        obs.disconnect();
        callback(targetNode);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  updateSetting({ name, value }) {
    if (this.#setting[name] === value) return;

    logger.debug("Youtube Provider: update setting", name, value);
    this.#setting[name] = value;

    this.#updateMenuProps(); // 更新菜单 props

    if (name === "isBilingual" || name === "blurTranslation") {
      this.#managerInstance?.updateSetting({ [name]: value });
    } else if (name === "showOrigin") {
      this.#toggleShowOrigin();
    } else if (name === "showLoadNotification" && value === false) {
      this.#hideNotification();
    }
  }

  #toggleShowOrigin() {
    if (this.#setting.showOrigin) {
      this.#destroyManager();
    } else {
      this.#startManager();
    }
  }

  downloadSubtitle() {
    if (!this.#subtitles.length || this.#progressed !== 100) {
      logger.debug("Youtube Provider: The subtitle is not yet ready.");
      return;
    }

    try {
      const vtt = buildBilingualVtt(this.#subtitles);
      downloadBlobFile(
        vtt,
        `babel-subtitles-${this.#videoId}_${Date.now()}.vtt`
      );
    } catch (error) {
      logger.info("Youtube Provider: download subtitles:", error);
    }
  }

  /**
   * 获取菜单组件的 props
   * @private
   */
  #getMenuProps() {
    const { transApis, skipAd, isBilingual, blurTranslation, showOrigin } =
      this.#setting;
    return {
      i18n: this.#i18n,
      updateSetting: this.updateSetting.bind(this),
      downloadSubtitle: this.downloadSubtitle.bind(this),
      transApis,
      progressed: this.#progressedNum,
      formData: {
        skipAd,
        isBilingual,
        blurTranslation,
        showOrigin,
      },
    };
  }

  /**
   * 更新菜单组件的 props
   * @private
   */
  #updateMenuProps() {
    if (this.#menuManager && this.#isMenuShow) {
      this.#menuManager.updateProps(this.#getMenuProps());
    }
  }

  #injectToggleButton(ytControls) {
    const babelControls = document.createElement("div");
    babelControls.className = "notranslate babel-subtitle-controls";
    Object.assign(babelControls.style, {
      height: "100%",
      position: "relative",
    });

    const toggleButton = document.createElement("button");
    toggleButton.className = "ytp-button babel-subtitle-button";
    toggleButton.title = APP_NAME;

    toggleButton.appendChild(createLogoSVG());
    babelControls.appendChild(toggleButton);

    // 使用新的 DomManager 替代 ShadowDomManager
    this.#menuManager = new DomManager({
      id: "babel-subtitle-menus",
      className: "notranslate",
      reactComponent: Menus,
      rootElement: babelControls,
      props: this.#getMenuProps(), // 获取菜单 props
    });

    toggleButton.onclick = () => {
      if (!this.#isMenuShow) {
        this.#isMenuShow = true;
        this.#toggleButton?.replaceChildren(
          createLogoSVG({ isSelected: true })
        );
        this.#menuManager.show();
        this.#updateMenuProps(); // 显示时更新 props
      } else {
        this.#isMenuShow = false;
        this.#toggleButton?.replaceChildren(createLogoSVG());
        this.#menuManager.hide();
      }
    };
    this.#toggleButton = toggleButton;

    ytControls?.prepend(babelControls);
  }

  #isSameLang(lang1, lang2) {
    if (!lang1 || !lang2) return false;
    return lang1.slice(0, 2) === lang2.slice(0, 2);
  }

  #isChatCaptionTrack(track) {
    if (!track) return false;
    const name = track.name?.simpleText || track.name?.runs?.[0]?.text || "";
    return /chat/i.test(name);
  }

  #buildTrackKey(potUrl) {
    const p = potUrl.searchParams;
    return [
      p.get("v") || "",
      p.get("lang") || "",
      p.get("kind") || "",
      p.get("name") || "",
      p.get("tlang") || "",
    ].join("|");
  }

  #isStaleProcessing(version) {
    return version !== this.#processingVersion;
  }

  // todo: 优化逻辑
  #findCaptionTrack(captionTracks, lang, kind) {
    logger.debug("Youtube Provider: find caption track", {
      captionTracks,
      lang,
      kind,
    });

    if (!captionTracks?.length) {
      return null;
    }

    // 优先匹配用户选择的字幕轨（语言+kind完全一致）
    // 手动字幕没有 kind 字段，统一转成 null，避免 undefined !== null 导致无法匹配
    let captionTrack = captionTracks.find(
      (item) =>
        item.languageCode === lang && (item.kind || null) === (kind || null)
    );
    if (!captionTrack) {
      captionTrack = captionTracks.find((item) => item.languageCode === lang);
    }
    if (!captionTrack) {
      const asrTrack = captionTracks.find((item) => item.kind === "asr");
      if (asrTrack) {
        captionTrack = captionTracks.find(
          (item) =>
            item.kind !== "asr" &&
            this.#isSameLang(item.languageCode, asrTrack.languageCode)
        );
        if (!captionTrack) {
          captionTrack = asrTrack;
        }
      }
    }

    if (!captionTrack) {
      captionTrack = captionTracks.pop();
    }

    // Chat/弹幕字幕轨道自动降级为正常字幕轨道
    if (captionTrack && this.#isChatCaptionTrack(captionTrack)) {
      logger.debug(
        "Youtube Provider: detected chat subtitle track, switching to normal subtitle"
      );

      const nonChatSameLang = captionTracks.find(
        (item) =>
          this.#isSameLang(item.languageCode, lang) &&
          !this.#isChatCaptionTrack(item)
      );

      if (nonChatSameLang) {
        logger.debug(
          "Youtube Provider: switched to same-language non-chat track"
        );
        captionTrack = nonChatSameLang;
      } else {
        const anyNonChat = captionTracks.find(
          (item) => !this.#isChatCaptionTrack(item)
        );
        if (anyNonChat) {
          logger.debug("Youtube Provider: switched to fallback non-chat track");
          captionTrack = anyNonChat;
        }
      }
    }

    return captionTrack;
  }

  async #getCaptionTracks(videoId) {
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const html = await fetch(url).then((r) => r.text());
      const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
      if (!match) return {};
      const data = JSON.parse(match[1]);
      return {
        captionTracks:
          data.captions?.playerCaptionsTracklistRenderer?.captionTracks,
      };
    } catch (err) {
      logger.info("Youtube Provider: get captionTracks", err);
      return {};
    }
  }

  async #getSubtitleEvents(capUrl, potUrl, responseText) {
    if (
      !potUrl.searchParams.get("tlang") &&
      potUrl.searchParams.get("kind") === capUrl.searchParams.get("kind") &&
      this.#isSameLang(
        potUrl.searchParams.get("lang"),
        capUrl.searchParams.get("lang")
      )
    ) {
      try {
        const json = JSON.parse(responseText);
        return json?.events;
      } catch (err) {
        logger.info("Youtube Provider: parse responseText", err);
        return null;
      }
    }

    try {
      potUrl.searchParams.delete("tlang");
      potUrl.searchParams.delete("name");
      potUrl.searchParams.set("lang", capUrl.searchParams.get("lang"));
      potUrl.searchParams.set("fmt", "json3");
      if (capUrl.searchParams.get("kind")) {
        potUrl.searchParams.set("kind", capUrl.searchParams.get("kind"));
      } else {
        potUrl.searchParams.delete("kind");
      }

      const res = await fetch(potUrl.href);
      if (res?.ok) {
        const json = await res.json();
        return json?.events;
      }
      logger.info(`Youtube Provider: Failed to fetch subtitles: ${res.status}`);
      return null;
    } catch (error) {
      logger.info("Youtube Provider: fetching subtitles error", error);
      return null;
    }
  }

  #getFromLang(lang) {
    if (lang === "zh") {
      return "zh-CN";
    }

    return (
      OPT_LANGS_SPEC_DEFAULT.get(lang) ||
      OPT_LANGS_SPEC_DEFAULT.get(lang.slice(0, 2)) ||
      OPT_LANGS_TO_CODE[OPT_TRANS_MICROSOFT].get(lang) ||
      OPT_LANGS_TO_CODE[OPT_TRANS_MICROSOFT].get(lang.slice(0, 2)) ||
      "auto"
    );
  }

  async #handleInterceptedRequest(url, responseText) {
    const videoId = this.#videoId;
    if (!videoId) {
      logger.debug("Youtube Provider: videoId not found.");
      return;
    }

    const potUrl = new URL(url);
    if (videoId !== potUrl.searchParams.get("v")) {
      logger.debug("Youtube Provider: skip other timedtext:", videoId);
      return;
    }

    const lang = potUrl.searchParams.get("lang");
    if (!lang) {
      logger.debug("Youtube Provider: timedtext lang not found:", url);
      return;
    }

    const interceptedKind = potUrl.searchParams.get("kind") || null;
    const trackKey = this.#buildTrackKey(potUrl);
    const fromLang = this.#getFromLang(lang);

    if (this.#flatEvents.length && trackKey === this.#activeTrackKey) {
      logger.debug("Youtube Provider: track was processed:", trackKey);
      return;
    }

    if (this.#processingId === trackKey) {
      logger.debug("Youtube Provider: track is processing:", trackKey);
      return;
    }

    const processingVersion = (this.#processingVersion += 1);
    this.#processingId = trackKey;
    this.#activeAbortController?.abort();
    this.#activeAbortController = new AbortController();

    if (this.#flatEvents.length) {
      this.#destroyManager();
      clearMsgHistory(this.#setting.apiSlug);
      this.#subtitles = [];
      this.#events = [];
      this.#flatEvents = [];
      this.#progressed = 0;
      this.#activeTrackKey = null;
      this.#interceptedCaptionKind = null;
    }

    try {
      this.#showNotification(this.#i18n("starting_to_process_subtitle"));

      const { toLang } = this.#setting;
      let events = extractOriginalSubtitleEventsFromTimedtextResponse({
        url,
        responseText,
      });
      if (!events) {
        const { captionTracks } = await this.#getCaptionTracks(videoId);
        if (this.#isStaleProcessing(processingVersion)) return;
        const captionTrack = this.#findCaptionTrack(
          captionTracks,
          lang,
          interceptedKind
        );
        if (!captionTrack) {
          logger.debug("Youtube Provider: CaptionTrack not found:", videoId);
          return;
        }
        if (!captionTrack.baseUrl.startsWith("https")) {
          captionTrack.baseUrl = window.location.origin + captionTrack.baseUrl;
        }
        const capUrl = new URL(captionTrack.baseUrl);
        events = await this.#getSubtitleEvents(capUrl, potUrl, responseText);
      }
      if (this.#isStaleProcessing(processingVersion)) return;

      if (!events?.length) {
        logger.debug("Youtube Provider: events not got:", videoId);
        return;
      }

      logger.debug(
        `Youtube Provider: lang: ${lang}, fromLang: ${fromLang}, toLang: ${toLang}`
      );
      if (this.#isSameLang(fromLang, toLang)) {
        logger.debug("Youtube Provider: skip same lang", fromLang, toLang);
        this.#showNotification(this.#i18n("subtitle_same_lang"));
        return;
      }

      const flatEvents = this.#genFlatEvents(events);
      if (!flatEvents?.length) {
        logger.debug("Youtube Provider: flatEvents not got:", videoId);
        return;
      }
      if (this.#isStaleProcessing(processingVersion)) return;

      this.#events = events;
      this.#flatEvents = flatEvents;
      this.#fromLang = fromLang;
      this.#interceptedCaptionKind = interceptedKind;
      this.#activeTrackKey = trackKey;
      this.#docInfo = getDocInfo();

      this.#processEvents({
        videoId,
        flatEvents,
        fromLang,
        processingVersion,
      });
    } catch (error) {
      logger.warn("Youtube Provider: handle subtitle", error);
      this.#showNotification(this.#i18n("subtitle_load_failed"));
    } finally {
      if (
        !this.#isStaleProcessing(processingVersion) &&
        this.#processingId === trackKey
      ) {
        this.#processingId = null;
      }
    }
  }

  async #processEvents({ videoId, flatEvents, fromLang, processingVersion }) {
    try {
      const [subtitles, progressed] = await this.#eventsToSubtitles({
        events: this.#events,
        flatEvents,
        fromLang,
        processingVersion,
      });
      if (this.#isStaleProcessing(processingVersion)) return;

      if (!subtitles?.length) {
        logger.debug(
          "Youtube Provider: events to subtitles got empty",
          videoId
        );
        return;
      }

      if (videoId !== this.#videoId) {
        logger.debug(
          "Youtube Provider: videoId changed!",
          videoId,
          this.#videoId
        );
        return;
      }

      this.#subtitles = subtitles;
      this.#progressed = progressed;

      // 如果用户开启了 babel 且视频被暂停等待中，则恢复播放
      if (this.#pauseRequested) {
        this.#pauseRequested = false;
        this.#videoEl?.play();
      }

      this.#startManager();
    } catch (error) {
      logger.info("Youtube Provider: process events", error);
      this.#showNotification(this.#i18n("subtitle_load_failed"));
    }
  }

  async #eventsToSubtitles({
    events,
    flatEvents,
    fromLang,
    processingVersion,
  }) {
    const isAutoCaption = this.#interceptedCaptionKind === "asr";

    // 格式化字幕（ASR 内置断句 或 手动字幕原文）
    let subtitles;
    if (isAutoCaption) {
      subtitles = this.#builtinSegment(events, flatEvents, fromLang);
    } else {
      logger.info(
        "Youtube Provider: Sentence break mode: MANUAL (human caption)"
      );
      subtitles = flatEvents.filter((e) => e.text);
    }

    // 批量翻译全部字幕：固定 chunk 队列并发翻译，首个 chunk 完成后即可显示
    if (subtitles.length > 0 && !this.#isStaleProcessing(processingVersion)) {
      this.#subtitles = subtitles;
      this.#progressed = 1;
      this.#startManager();

      const translated = await this.#batchTranslateAll({
        subtitles,
        fromLang,
        processingVersion,
      });
      if (this.#isStaleProcessing(processingVersion)) return [[], 0];
      subtitles = translated;
    }

    return [subtitles, 100];
  }

  /**
   * 批量翻译全部字幕：固定 chunk 队列并发翻译，每个 chunk 严格解析和独立重试。
   */
  async #batchTranslateAll({ subtitles, fromLang, processingVersion }) {
    const { apiSetting, toLang } = this.#setting;
    if (!apiSetting || !subtitles?.length) return subtitles;
    return this.#chunkTranslateAll({
      subtitles,
      fromLang,
      toLang,
      apiSetting,
      processingVersion,
    });
  }

  async #chunkTranslateAll({
    subtitles,
    fromLang,
    toLang,
    apiSetting,
    processingVersion,
  }) {
    const textIndices = [];
    const texts = [];
    subtitles.forEach((sub, i) => {
      if (sub.text?.trim()) {
        textIndices.push(i);
        texts.push(sub.text.trim());
      }
    });

    if (!texts.length) return subtitles;

    const MAX_CHUNK_ATTEMPTS = 3;
    const videoId = this.#videoId;
    const chunks = splitSubtitleTranslationChunks(texts, {
      firstChunkSize: 20,
      secondChunkSize: 40,
      chunkSize: 80,
      contextSize: 10,
    });
    const translations = new Array(texts.length).fill("");

    const updateTranslationProgress = () => {
      if (!this.#isStaleProcessing(processingVersion)) {
        this.#progressed = getSubtitleTranslationProgress(texts, translations);
      }
    };

    const applyChunkTranslations = (chunk, chunkTranslations) => {
      chunk.segmentIds.forEach((textIndex, localIndex) => {
        const translation = String(chunkTranslations[localIndex] || "").trim();
        if (!translation) return;

        translations[textIndex] = chunkTranslations[localIndex];
        const originalIndex = textIndices[textIndex];
        subtitles[originalIndex] = {
          ...subtitles[originalIndex],
          translation: chunkTranslations[localIndex],
        };
        this.#subtitleListManager?.updateSingleSubtitle({
          start: subtitles[originalIndex].start,
          translation: chunkTranslations[localIndex],
        });
      });

      updateTranslationProgress();
      if (chunk.start === 0) {
        this.#startManager();
        if (this.#pauseRequested && this.#managerInstance) {
          this.#pauseRequested = false;
          this.#videoEl?.play();
        }
      }
    };

    const translateChunk = async (chunk) => {
      for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
        if (this.#isStaleProcessing(processingVersion)) return false;

        try {
          const chunkTranslations = await apiBatchSubtitleTranslate({
            texts: chunk.texts,
            fromLang,
            toLang,
            apiSetting,
            docInfo: this.#docInfo,
            videoId: `${videoId || ""}:chunk:${chunk.start}-${chunk.end}`,
            signal: this.#activeAbortController?.signal,
            contextBefore: chunk.contextBefore,
            contextAfter: chunk.contextAfter,
            strict: true,
          });

          if (this.#isStaleProcessing(processingVersion)) return false;

          if (
            countFilledTranslations(chunkTranslations) === chunk.texts.length
          ) {
            applyChunkTranslations(chunk, chunkTranslations);
            logger.info(
              `Youtube Provider: Chunk translated ${chunk.start}-${chunk.end} (${chunk.texts.length})`
            );
            return true;
          }

          throw new Error(
            `incomplete strict chunk: ${countFilledTranslations(
              chunkTranslations
            )}/${chunk.texts.length}`
          );
        } catch (err) {
          if (this.#isStaleProcessing(processingVersion)) return false;
          logger.warn(
            `Youtube Provider: Chunk ${chunk.start}-${chunk.end} attempt ${attempt}/${MAX_CHUNK_ATTEMPTS} failed`,
            err
          );
        }
      }

      logger.warn(
        `Youtube Provider: Chunk ${chunk.start}-${chunk.end} failed after ${MAX_CHUNK_ATTEMPTS} attempts; leaving it untranslated`
      );
      return false;
    };

    updateTranslationProgress();
    logger.info(
      `Youtube Provider: Translating ${texts.length} subtitles in ${chunks.length} strict chunks`
    );

    await runSubtitleChunksFirstThenAll(chunks, translateChunk);
    updateTranslationProgress();
    this.#managerInstance?.onSeek?.();

    logger.info(
      `Youtube Provider: Chunk translation finished ${countFilledTranslations(translations)}/${texts.length} subtitles`
    );
    return subtitles;
  }

  #builtinSegment(events, flatEvents, fromLang) {
    const { useAlgorithmBreaker } = this.#setting;

    if (useAlgorithmBreaker === "statistical") {
      logger.info("Youtube Provider: Sentence break mode: STATISTICAL");
      const result = this.#algorithmicSegment(events, fromLang);
      if (result?.length) return result;
      logger.info("Youtube Provider: Statistical segmentation returned empty");
      return [];
    }

    logger.info("Youtube Provider: Sentence break mode: RULE");
    return this.#formatSubtitles(flatEvents, fromLang);
  }

  #algorithmicSegment(events, fromLang) {
    try {
      const algorithmicSubtitles = intelligentSentenceBreak({ events });
      return algorithmicSubtitles.map((sub) => ({
        text: sub.text,
        start: sub.start,
        end: sub.end,
        translation: "",
      }));
    } catch (error) {
      logger.info("Youtube Provider: Error in algorithmic segmentation", error);
      return null;
    }
  }

  #startManager() {
    if (!this.#isYtSubtitleEnabled()) {
      return;
    }

    if (this.#managerInstance) {
      return;
    }

    if (this.#setting.showOrigin) {
      return;
    }

    if (
      !this.#subtitles.length ||
      (this.#progressed !== 100 &&
        !isInitialSubtitleChunkReady(this.#subtitles))
    ) {
      this.#showNotification(this.#i18n("waitting_for_subtitle"));
      this.#videoEl?.pause();
      this.#pauseRequested = true;
      return;
    }

    const videoEl = this.#videoEl;
    if (!videoEl) {
      logger.warn("Youtube Provider: No video element found");
      return;
    }

    logger.info("Youtube Provider: Starting manager...");

    this.#managerInstance = new BilingualSubtitleManager({
      videoEl,
      formattedSubtitles: this.#subtitles,
      setting: {
        ...this.#setting,
        fromLang: this.#fromLang,
        docInfo: this.#docInfo,
      },
    });

    // 监听字幕更新事件，将翻译后的字幕传递给字幕列表
    const showList = isSubtitleModeEnabled(
      this.#setting.showList,
      this.#setting.enhanceMode
    );

    if (showList && !this.#subtitleListManager) {
      // 初始化字幕列表管理器
      this.#subtitleListManager = new YouTubeSubtitleList(videoEl);
      this.#subtitleListManager.initialize(this.#subtitles);

      // 监听字幕更新事件，在字幕翻译完成后增量更新字幕列表
      this.#managerInstance.onSubtitleUpdate = (subtitleUpdate) => {
        this.#subtitleListManager.updateSingleSubtitle(subtitleUpdate);
      };

      // 创建包含翻译信息的双语字幕数据（初始可能没有翻译）
      const bilingualSubtitles = this.#subtitles.map((sub) => ({
        start: sub.start,
        end: sub.end,
        text: sub.text,
        translation: sub.translation || "",
      }));

      // 将双语字幕数据传递给字幕列表
      this.#subtitleListManager.setBilingualSubtitles(bilingualSubtitles);
      // 启动字幕列表自动滚动
      this.#subtitleListManager.turnOnAutoSub();
    }

    this.#managerInstance.start();

    this.#showNotification(this.#i18n("subtitle_load_succeed"));

    this.#hideYtCaption();
  }

  #destroyManager() {
    this.#showYtCaption();

    if (!this.#managerInstance) {
      return;
    }

    logger.info("Youtube Provider: Destroying manager...");

    this.#managerInstance.onSubtitleUpdate = null;
    this.#managerInstance.destroy();
    this.#managerInstance = null;

    // 销毁字幕列表
    if (this.#subtitleListManager) {
      this.#subtitleListManager.destroy();
      this.#subtitleListManager = null;
    }
  }

  #hideYtCaption() {
    const ytCaption = document.querySelector(YT_CAPTION_SELECT);
    ytCaption && (ytCaption.style.top = "-10000px");
  }

  #showYtCaption() {
    const ytCaption = document.querySelector(YT_CAPTION_SELECT);
    ytCaption && (ytCaption.style.top = "0");
  }

  #formatSubtitles(flatEvents, lang) {
    if (!flatEvents?.length) return [];

    const noSpaceLanguages = [
      "zh", // 中文
      "ja", // 日文
      "ko", // 韩文（现代用空格，但结构上仍可连写）
      "th", // 泰文
      "lo", // 老挝文
      "km", // 高棉文
      "my", // 缅文
    ];

    if (noSpaceLanguages.some((l) => lang?.startsWith(l))) {
      const subtitles = [];

      if (this.#isQualityPoor(flatEvents, 5, 0.5)) {
        return flatEvents;
      }

      let currentLine = null;
      const MAX_LENGTH = 30;

      for (const segment of flatEvents) {
        if (segment.text) {
          if (!currentLine) {
            currentLine = {
              text: segment.text,
              start: segment.start,
              end: segment.end,
            };
          } else {
            currentLine.text += segment.text;
            currentLine.end = segment.end;
          }

          if (currentLine.text.length >= MAX_LENGTH) {
            subtitles.push(currentLine);
            currentLine = null;
          }
        } else {
          if (currentLine) {
            subtitles.push(currentLine);
            currentLine = null;
          }
        }
      }

      if (currentLine) {
        subtitles.push(currentLine);
      }

      // 日语自动字幕延长 end 时间，防止字幕提前消失
      if (lang?.startsWith("ja") && this.#interceptedCaptionKind === "asr") {
        subtitles.forEach((sub, i) => {
          if (subtitles[i + 1]) {
            sub.end = subtitles[i + 1].start;
          } else {
            sub.end = Math.max(sub.end, sub.start + 2000);
          }
        });
      }

      return subtitles;
    }

    let subtitles = this.#processSubtitles({ flatEvents });

    const longSentenceThreshold = this.#setting.longSentenceThreshold ?? 120;
    const result = [];
    for (const sub of subtitles) {
      if (sub.text.length > longSentenceThreshold) {
        const subEvents = flatEvents.filter(
          (e) => e.start >= sub.start && e.start < sub.end
        );
        if (subEvents.length > 1) {
          logger.debug(
            "Youtube Provider: re-processing long sentence with pause",
            {
              length: sub.text.length,
              text: sub.text.slice(0, 50) + "...",
            }
          );
          const reProcessed = this.#processSubtitles({
            flatEvents: subEvents,
            usePause: true,
          });
          result.push(...reProcessed);
        } else {
          result.push(sub);
        }
      } else {
        result.push(sub);
      }
    }
    subtitles = result;

    return subtitles;
  }

  #isQualityPoor(lines, lengthThreshold = 200, percentageThreshold = 0.1) {
    if (lines.length === 0) return false;
    const longLinesCount = lines.filter(
      (line) => line.text.length > lengthThreshold
    ).length;
    logger.debug("Youtube Provider: quality check", {
      longLinesCount,
      totalLines: lines.length,
      percentage: longLinesCount / lines.length,
    });
    return longLinesCount / lines.length > percentageThreshold;
  }

  #processSubtitles({
    flatEvents,
    usePause = false,
    timeout = 1000,
    maxWords = 15,
    maxDurationMs = 10000,
  } = {}) {
    const groupedPauseWords = {
      1: new Set([
        "actually",
        "also",
        "although",
        "and",
        "anyway",
        "as",
        "basically",
        "because",
        "but",
        "eventually",
        "frankly",
        "honestly",
        "hopefully",
        "however",
        "if",
        "instead",
        "it's",
        "just",
        "let's",
        "like",
        "literally",
        "maybe",
        "meanwhile",
        "nevertheless",
        "nonetheless",
        "now",
        "okay",
        "or",
        "otherwise",
        "perhaps",
        "personally",
        "probably",
        "right",
        "since",
        "so",
        "suddenly",
        "that's",
        "then",
        "there's",
        "therefore",
        "though",
        "thus",
        "unless",
        "until",
        "well",
        "while",
      ]),
      2: new Set([
        "after all",
        "at first",
        "at least",
        "even if",
        "even though",
        "for example",
        "for instance",
        "i believe",
        "i guess",
        "i mean",
        "i suppose",
        "i think",
        "in fact",
        "in the end",
        "of course",
        "then again",
        "to be fair",
        "you know",
        "you see",
      ]),
      3: new Set([
        "as a result",
        "by the way",
        "in other words",
        "in that case",
        "in this case",
        "to be clear",
        "to be honest",
      ]),
    };

    const sentences = [];
    let currentBuffer = [];
    let bufferWordCount = 0;

    const flushBuffer = () => {
      if (currentBuffer.length > 0) {
        sentences.push({
          text: currentBuffer
            .map((s) => s.text)
            .join(" ")
            .trim(),
          start: currentBuffer[0].start,
          end: currentBuffer[currentBuffer.length - 1].end,
        });
      }
      currentBuffer = [];
      bufferWordCount = 0;
    };

    flatEvents.forEach((segment) => {
      if (!segment.text) return;

      const lastSegment = currentBuffer[currentBuffer.length - 1];

      if (lastSegment) {
        const isEndOfSentence = /[.?!…\])]$/.test(lastSegment.text);
        const isPauseOfSentence = /[,]$/.test(lastSegment.text);
        const isTimeout = segment.start - lastSegment.end > timeout;
        const isDurationExceeded =
          segment.start - currentBuffer[0].start >= maxDurationMs;
        const isWordLimitExceeded =
          (usePause || isPauseOfSentence) && bufferWordCount >= maxWords;

        const startsWithSign = /^[[(♪]/.test(segment.text);
        const startsWithPauseWord =
          usePause &&
          groupedPauseWords["1"].has(
            segment.text.toLowerCase().split(" ")[0]
          ) &&
          currentBuffer.length > 1;

        if (
          isEndOfSentence ||
          isTimeout ||
          isDurationExceeded ||
          isWordLimitExceeded ||
          startsWithSign ||
          startsWithPauseWord
        ) {
          flushBuffer();
        }
      }

      currentBuffer.push(segment);
      bufferWordCount += segment.text.split(/\s+/).length;
    });

    flushBuffer();

    return sentences;
  }

  #genFlatEvents(events = []) {
    const segments = [];
    let buffer = null;

    events.forEach(({ segs = [], tStartMs = 0, dDurationMs = 0 }) => {
      segs.forEach(({ utf8 = "", tOffsetMs = 0 }, j) => {
        const text = utf8
          .replace(/<[^>]+>/g, "")
          .trim()
          .replace(/\s+/g, " ");
        const start = tStartMs + tOffsetMs;

        if (buffer) {
          if (!buffer.end || buffer.end > start) {
            buffer.end = start;
          }
          segments.push(buffer);
          buffer = null;
        }

        buffer = {
          text,
          start,
        };

        if (j === segs.length - 1) {
          buffer.end = tStartMs + dDurationMs;
        }
      });
    });

    if (buffer) {
      segments.push(buffer);
    }

    return segments.filter(
      (s) => s && typeof s.start === "number" && s.end > s.start
    );
  }

  #createNotificationElement() {
    const notificationEl = document.createElement("div");
    notificationEl.className = "babel-notification";
    Object.assign(notificationEl.style, {
      position: "absolute",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(0, 0, 0, 0.5)",
      color: "#fff",
      padding: "8px 12px",
      borderRadius: "8px",
      zIndex: "2147483647",
      opacity: "0",
      transition: "opacity 0.3s ease-in-out",
      pointerEvents: "none",
      fontSize: "16px",
      lineHeight: "1.4",
      width: "auto",
      maxWidth: "min(360px, calc(100% - 32px))",
      textAlign: "left",
      boxSizing: "border-box",
      boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
    });

    const videoEl = this.#videoEl;
    const videoContainer = videoEl?.parentElement?.parentElement;
    if (videoContainer) {
      videoContainer.appendChild(notificationEl);
      this.#notificationEl = notificationEl;
    }
  }

  #hideNotification() {
    clearTimeout(this.#notificationTimeout);
    if (this.#notificationEl) {
      this.#notificationEl.style.opacity = "0";
    }
  }

  #showNotification(message, options) {
    if (this.#setting.showLoadNotification === false) {
      this.#hideNotification();
      return;
    }

    let duration = 2000;
    if (typeof options === "number") {
      duration = options;
    } else if (options && typeof options === "object") {
      duration = options.duration ?? 2000;
      // options.spinner 当前不被 UI 实现支持，忽略即可
    }

    if (!this.#notificationEl) this.#createNotificationElement();
    if (!this.#notificationEl) return;

    this.#notificationEl.textContent = message;
    this.#notificationEl.style.opacity = "1";
    clearTimeout(this.#notificationTimeout);
    this.#notificationTimeout = setTimeout(() => {
      this.#hideNotification();
    }, duration);
  }
}

export const YouTubeInitializer = (() => {
  let initialized = false;

  return async (setting) => {
    if (initialized) {
      return;
    }
    initialized = true;

    logger.info("Bilingual Subtitle Extension: Initializing...");
    const provider = new YouTubeCaptionProvider(setting);
    provider.initialize();
  };
})();
