import { logger } from "../libs/log.js";
import { truncateWords } from "../libs/utils.js";
import { apiMicrosoftDict } from "../apis/index.js";
import { trustedTypesHelper } from "../libs/trustedTypes.js";
import { isSubtitleModeEnabled } from "./modes.js";

// 添加CSS样式用于高亮显示悬停的单词
const addWordHoverStyles = () => {
  if (document.getElementById("babel-word-hover-styles")) return;

  const style = document.createElement("style");
  style.id = "babel-word-hover-styles";
  style.textContent = `
    .babel-word-hover {
      cursor: pointer;
      text-decoration: underline;
      text-decoration-color: #4fc3f7;
      text-decoration-thickness: 2px;
    }
    
    .babel-word-tooltip {
      position: fixed;
      background: rgba(0, 0, 0, 0.9);
      color: white;
      border-radius: 6px;
      padding: 12px;
      font-size: 14px;
      z-index: 2147483647;
      max-width: 300px;
      word-wrap: break-word;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(4px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      font-family: Arial, sans-serif;
    }
    
    .babel-word-tooltip-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-weight: bold;
      font-size: 16px;
      color: #4fc3f7;
    }
    
    .babel-word-tooltip-close {
      background: none;
      border: none;
      color: #aaa;
      cursor: pointer;
      font-size: 18px;
      padding: 0;
      margin-left: 10px;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .babel-word-tooltip-close:hover {
      color: white;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 50%;
    }
    
    .babel-word-loading {
      color: #bbb;
      font-style: italic;
    }
    
    .babel-word-definition {
      margin: 4px 0;
    }
    
    .babel-word-pos {
      color: #4fc3f7;
      font-weight: bold;
    }
    
    .babel-word-phonetic {
      color: #bbb;
      font-style: italic;
      margin-right: 10px;
    }
    
    .babel-word-example {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid #444;
    }
    
    .babel-word-example-title {
      font-weight: bold;
      margin-bottom: 5px;
    }
    
    .babel-word-example-sentence {
      margin-bottom: 3px;
    }
    
    .babel-word-example-translation {
      color: #bbb;
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
};

/**
 * @class BilingualSubtitleManager
 * @description 负责在视频上显示和翻译字幕的核心逻辑
 */
export class BilingualSubtitleManager {
  #videoEl;
  #formattedSubtitles = [];
  #captionWindowEl = null;
  #captionDragged = false;
  #paperEl = null;
  #currentSubtitleIndex = -1;
  #setting = {};
  #isAdPlaying = false;
  #tooltipEl = null;
  #hoverTimeout = null;
  #wasPlayingBeforeSubtitleHover = false;
  #playerControlBarObserver = null;

  /**
   * @param {object} options
   * @param {HTMLVideoElement} options.videoEl - 页面上的 video 元素。
   * @param {Array<object>} options.formattedSubtitles - 已格式化好的字幕数组。
   * @param {object} options.setting - 配置对象，如目标翻译语言。
   */
  constructor({ videoEl, formattedSubtitles, setting }) {
    this.#setting = setting;
    this.#videoEl = videoEl;
    this.#formattedSubtitles = formattedSubtitles;

    this.onTimeUpdate = this.onTimeUpdate.bind(this);
    this.onSeeking = this.onSeeking.bind(this);
    this.onSeek = this.onSeek.bind(this);

    if (this.#isHoverLookupEnabled()) {
      addWordHoverStyles();
    }
  }

  #isHoverLookupEnabled() {
    return isSubtitleModeEnabled(
      this.#setting.hoverLookupMode,
      this.#setting.enhanceMode
    );
  }

  /**
   * 启动字幕显示。
   */
  start() {
    if (this.#formattedSubtitles.length === 0) {
      logger.warn("Bilingual Subtitles: No subtitles to display.");
      return;
    }

    logger.info("Bilingual Subtitle Manager: Starting...");
    this.#createCaptionWindow();
    this.#attachEventListeners();
    this.onTimeUpdate();
  }

  /**
   * 销毁实例，清理资源。
   */
  destroy() {
    logger.info("Bilingual Subtitle Manager: Destroying...");
    this.onSubtitleUpdate = null;
    this.#removeEventListeners();
    this.#captionWindowEl?.parentElement?.parentElement?.remove();
    this.#playerControlBarObserver?.disconnect();
    this.#playerControlBarObserver = null;
    this.#formattedSubtitles = [];
    if (this.#tooltipEl) {
      this.#tooltipEl.remove();
      this.#tooltipEl = null;
    }
    if (this.#hoverTimeout) {
      clearTimeout(this.#hoverTimeout);
      this.#hoverTimeout = null;
    }
  }

  /**
   * 更新广告播放状态。
   */
  setIsAdPlaying(isPlaying) {
    this.#isAdPlaying = isPlaying;
    this.onTimeUpdate();
  }

  /**
   * 监听播放器控制条的显示状态，隐藏时将字幕下移
   */
  #observePlayerControlBar() {
    const player = this.#videoEl.closest(".html5-video-player");
    if (!player) return;
    const controlBar = player.querySelector(".ytp-left-controls");
    if (!controlBar) return;
    let controlBarHeight = parseFloat(getComputedStyle(controlBar).height);

    // 根据当前控制条状态初始化位置
    const isHiddenNow = player.classList.contains("ytp-autohide");
    let initialBottom = player.clientHeight * 0.05;
    if (!isHiddenNow) initialBottom += controlBarHeight;
    this.#paperEl.style.bottom = `${initialBottom}px`;
    let lastControlBarHiddenState = isHiddenNow;

    const updatePaperElBottom = () => {
      const isHidden = player.classList.contains("ytp-autohide");
      if (isHidden === lastControlBarHiddenState) return;
      lastControlBarHiddenState = isHidden;

      let currentBottom = parseFloat(this.#paperEl.style.bottom) || 0;
      let newBottom = isHidden
        ? currentBottom - controlBarHeight
        : currentBottom + controlBarHeight;

      this.#paperEl.style.bottom = `${newBottom}px`;
    };

    const observer = new MutationObserver(() => {
      if (!this.#captionDragged) updatePaperElBottom();
    });
    observer.observe(player, { attributes: true, attributeFilter: ["class"] });
    this.#playerControlBarObserver = observer;
  }

  /**
   * 创建并配置用于显示字幕的 DOM 元素。
   */
  #createCaptionWindow() {
    const container = document.createElement("div");
    container.className = `babel-caption-container notranslate`;
    Object.assign(container.style, {
      position: "absolute",
      width: "100%",
      height: "100%",
      left: "0",
      top: "0",
      pointerEvents: "none",
    });

    const paper = document.createElement("div");
    paper.className = `babel-caption-paper`;
    Object.assign(paper.style, {
      position: "absolute",
      width: "80%",
      left: "50%",
      transform: "translateX(-50%)",
      textAlign: "center",
      containerType: "inline-size",
      zIndex: "2147483647",
      pointerEvents: "auto",
      display: "none",
    });
    this.#paperEl = paper;

    this.#captionWindowEl = document.createElement("div");
    this.#captionWindowEl.className = `babel-caption-window`;
    this.#captionWindowEl.style.cssText = this.#setting.windowStyle;
    this.#captionWindowEl.style.pointerEvents = "auto";
    this.#captionWindowEl.style.cursor = "grab";
    this.#captionWindowEl.style.opacity = "1";

    this.#paperEl.appendChild(this.#captionWindowEl);
    container.appendChild(this.#paperEl);

    const videoContainer = this.#videoEl.parentElement?.parentElement;
    if (!videoContainer) {
      logger.warn("could not find videoContainer");
      return;
    }

    videoContainer.style.position = "relative";
    videoContainer.appendChild(container);

    this.#enableDragging(
      this.#paperEl,
      container,
      this.#captionWindowEl,
      () => (this.#captionDragged = true)
    );

    this.#captionWindowEl.addEventListener("pointerenter", (e) => {
      if (
        e.target === this.#captionWindowEl &&
        this.#setting.pauseOnSubtitleHover === true
      ) {
        this.#wasPlayingBeforeSubtitleHover =
          this.#videoEl && !this.#videoEl.paused;
        if (this.#wasPlayingBeforeSubtitleHover) {
          this.#videoEl.pause();
        }
      }
    });

    this.#captionWindowEl.addEventListener("pointerleave", (e) => {
      if (
        e.target === this.#captionWindowEl &&
        this.#setting.pauseOnSubtitleHover === true
      ) {
        if (
          this.#wasPlayingBeforeSubtitleHover &&
          this.#videoEl &&
          this.#videoEl.paused
        ) {
          this.#videoEl.play();
        }
        this.#wasPlayingBeforeSubtitleHover = false;
      }
    });

    this.#observePlayerControlBar();
  }

  // 处理单词悬停事件
  #handleWordHover(event) {
    const target = event.target;
    if (target.classList.contains("babel-subtitle-word")) {
      // 清除之前的定时器
      if (this.#hoverTimeout) {
        clearTimeout(this.#hoverTimeout);
        this.#hoverTimeout = null;
      }

      target.classList.add("babel-word-hover");

      // 延迟显示tooltip，避免误触
      this.#hoverTimeout = setTimeout(() => {
        this.#showWordTooltip(
          target.dataset.word,
          event.clientX,
          event.clientY
        );
      }, 300);
    }
  }

  // 处理鼠标移出事件
  #handleWordHoverOut(event) {
    const target = event.target;
    if (target.classList.contains("babel-subtitle-word")) {
      target.classList.remove("babel-word-hover");

      // 清除显示定时器
      if (this.#hoverTimeout) {
        clearTimeout(this.#hoverTimeout);
        this.#hoverTimeout = null;
      }

      // 延迟隐藏tooltip
      this.#hoverTimeout = setTimeout(() => {
        this.#hideWordTooltip();
      }, 100);
    }
  }

  // 处理鼠标移动事件
  #handleWordMouseMove(event) {
    // 不再跟随鼠标移动，保持tooltip在固定位置
    // 移除之前的逻辑
  }

  #attachSpanListeners() {
    if (!this.#captionWindowEl) return;
    const spans = this.#captionWindowEl.querySelectorAll(
      ".babel-subtitle-word"
    );
    spans.forEach((span) => {
      if (span.dataset.babelListenerAttached) return;
      const enterHandler = (e) => this.#handleWordHover(e);
      const leaveHandler = (e) => this.#handleWordHoverOut(e);
      span.addEventListener("pointerenter", enterHandler);
      span.addEventListener("pointerleave", leaveHandler);
      span.dataset.babelListenerAttached = "1";
    });
  }

  // 显示单词提示框
  async #showWordTooltip(word, x, y) {
    // 如果已经存在提示框，则先移除
    if (this.#tooltipEl) {
      this.#tooltipEl.remove();
    }

    // 创建提示框
    this.#tooltipEl = document.createElement("div");
    this.#tooltipEl.className = "babel-word-tooltip";
    trustedTypesHelper.setHTML(
      this.#tooltipEl,
      '<div class="babel-word-loading">Looking up...</div>'
    );

    // 将提示框定位在播放器右上角
    const videoContainer = this.#videoEl.parentElement?.parentElement;
    if (videoContainer) {
      const containerRect = videoContainer.getBoundingClientRect();
      const tooltipWidth = 300;
      const tooltipHeight = 400;

      // 定位在播放器右上角，距离右边缘45px，上下边缘各20px
      const left = containerRect.right - tooltipWidth - 45;
      const top = containerRect.top + 20;

      // 确保提示框不会超出浏览器窗口右边界
      const maxLeft = window.innerWidth - tooltipWidth - 10;
      this.#tooltipEl.style.left = Math.min(maxLeft, Math.max(10, left)) + "px";
      this.#tooltipEl.style.top = Math.max(10, top) + "px";
      this.#tooltipEl.style.maxWidth = tooltipWidth + "px";
      this.#tooltipEl.style.maxHeight = tooltipHeight + "px";
      this.#tooltipEl.style.overflow = "auto";
    }

    document.body.appendChild(this.#tooltipEl);

    try {
      // 获取单词翻译
      const dictResult = await apiMicrosoftDict(word);

      // 构造美式音标字符串
      let phonetic = "";
      if (dictResult && dictResult.aus) {
        // 只使用美式音标，去除"美"标签和方括号
        const usPhonetic = dictResult.aus.find((au) => au.key === "美");
        if (usPhonetic && usPhonetic.phonetic) {
          phonetic = usPhonetic.phonetic;
        } else if (dictResult.aus.length > 0 && dictResult.aus[0].phonetic) {
          // 如果没有明确标记为"美"的音标，使用第一个音标
          phonetic = dictResult.aus[0].phonetic;
        }
      }

      // 构造释义字符串
      let definition = "";
      if (dictResult && dictResult.trs) {
        definition = dictResult.trs
          .slice(0, 3)
          .map((tr) => `${tr.pos ? tr.pos + " " : ""}${tr.def}`)
          .join("; ");
      }

      // 构造例句数组
      let examples = [];
      if (dictResult && dictResult.sentences) {
        examples = dictResult.sentences.slice(0, 2).map((sentence) => ({
          eng: sentence.eng,
          chs: sentence.chs,
        }));
      }

      // 获取当前字幕的时间戳（使用重新分段后的时间）
      const currentTimeMs = this.#getCurrentSubtitleStartTime();

      // 添加单词和完整信息到生词本
      const event = new CustomEvent("babel-add-word", {
        detail: {
          word,
          phonetic, // 现在只包含音标本身，如 ɪnˈkredəb(ə)l
          definition,
          examples,
          timestamp: currentTimeMs, // 添加时间戳
        },
      });
      document.dispatchEvent(event);

      if (
        dictResult &&
        (dictResult.trs || dictResult.aus || dictResult.sentences)
      ) {
        let content = `<div class="babel-word-tooltip-header">
          <span>${word}</span>
          <button class="babel-word-tooltip-close">×</button>
        </div>`;

        // 显示音标
        if (dictResult.aus && dictResult.aus.length > 0) {
          content += "<div>";
          dictResult.aus.forEach((au) => {
            if (au.phonetic) {
              content += `<span class="babel-word-phonetic">${au.phonetic}</span>`;
            }
          });
          content += "</div>";
        }

        // 显示释义
        if (dictResult.trs) {
          dictResult.trs.slice(0, 3).forEach((tr) => {
            content += `<div class="babel-word-definition">${tr.pos ? '<span class="babel-word-pos">' + tr.pos + "</span> " : ""}${tr.def}</div>`;
          });
        }

        // 显示例句
        if (dictResult.sentences && dictResult.sentences.length > 0) {
          content += `<div class="babel-word-example">
            <div class="babel-word-example-title">例句</div>`;
          dictResult.sentences.slice(0, 2).forEach((sentence) => {
            content += `<div class="babel-word-example-sentence">${sentence.eng}</div>
              <div class="babel-word-example-translation">${sentence.chs}</div>`;
          });
          content += "</div>";
        }

        if (this.#tooltipEl) {
          trustedTypesHelper.setHTML(this.#tooltipEl, content);
          this.#attachTooltipCloseHandler();
        }
      } else {
        if (this.#tooltipEl) {
          trustedTypesHelper.setHTML(
            this.#tooltipEl,
            `<div class="babel-word-tooltip-header">
          <span>${word}</span>
          <button class="babel-word-tooltip-close">×</button>
        </div>
        <div class="babel-word-definition">No definition found</div>`
          );
          this.#attachTooltipCloseHandler();
        }
      }
    } catch (error) {
      logger.info("Dictionary lookup failed for word:", word, error);

      // 获取当前字幕的时间戳
      const currentTimeMs = this.#getCurrentSubtitleStartTime();

      // 即使查询失败，也将单词添加到生词本（无完整信息）
      const event = new CustomEvent("babel-add-word", {
        detail: {
          word,
          phonetic: "",
          definition: "",
          examples: [],
          timestamp: currentTimeMs, // 添加时间戳
        },
      });
      document.dispatchEvent(event);

      if (this.#tooltipEl) {
        trustedTypesHelper.setHTML(
          this.#tooltipEl,
          `<div class="babel-word-tooltip-header">
        <span>${word}</span>
        <button class="babel-word-tooltip-close">×</button>
      </div>
      <div class="babel-word-definition">Failed to load definition</div>`
        );
        this.#attachTooltipCloseHandler();
      }
    }
  }

  #attachTooltipCloseHandler() {
    const closeButton = this.#tooltipEl?.querySelector(
      ".babel-word-tooltip-close"
    );
    closeButton?.addEventListener("click", () => this.#hideWordTooltip());
  }

  // 隐藏单词提示框
  #hideWordTooltip() {
    if (this.#tooltipEl) {
      this.#tooltipEl.remove();
      this.#tooltipEl = null;
    }
  }

  /**
   * 为指定的元素启用垂直拖动功能。
   */
  #enableDragging(
    dragElement,
    boundaryContainer,
    handleElement,
    dragEndCallback
  ) {
    let isDragging = false;
    let startY;
    let initialBottom;
    let dragElementHeight;

    const onDragStart = (e) => {
      if (e.type === "mousedown" && e.button !== 0) return;

      e.preventDefault();

      isDragging = true;
      handleElement.style.cursor = "grabbing";
      startY = e.type === "touchstart" ? e.touches[0].clientY : e.clientY;

      initialBottom =
        boundaryContainer.getBoundingClientRect().bottom -
        dragElement.getBoundingClientRect().bottom;

      dragElementHeight = dragElement.offsetHeight;

      document.addEventListener("mousemove", onDragMove, { capture: true });
      document.addEventListener("touchmove", onDragMove, {
        capture: true,
        passive: false,
      });
      document.addEventListener("mouseup", onDragEnd, { capture: true });
      document.addEventListener("touchend", onDragEnd, { capture: true });
    };

    const onDragMove = (e) => {
      if (!isDragging) return;

      e.preventDefault();

      const currentY =
        e.type === "touchmove" ? e.touches[0].clientY : e.clientY;
      const deltaY = currentY - startY;
      let newBottom = initialBottom - deltaY;

      const containerHeight = boundaryContainer.clientHeight;
      newBottom = Math.max(0, newBottom);
      newBottom = Math.min(containerHeight - dragElementHeight, newBottom);
      if (dragElementHeight > containerHeight) {
        newBottom = Math.max(0, newBottom);
      }

      dragElement.style.bottom = `${newBottom}px`;
      if (dragEndCallback && typeof dragEndCallback === "function")
        dragEndCallback();
    };

    const onDragEnd = (e) => {
      if (!isDragging) return;

      e.preventDefault();

      isDragging = false;
      handleElement.style.cursor = "grab";

      document.removeEventListener("mousemove", onDragMove, { capture: true });
      document.removeEventListener("touchmove", onDragMove, { capture: true });
      document.removeEventListener("mouseup", onDragEnd, { capture: true });
      document.removeEventListener("touchend", onDragEnd, { capture: true });

      const finalBottomPx = dragElement.style.bottom;
      setTimeout(() => {
        dragElement.style.bottom = finalBottomPx;
      }, 50);
    };

    handleElement.addEventListener("mousedown", onDragStart);
    handleElement.addEventListener("touchstart", onDragStart, {
      passive: false,
    });
  }

  /**
   * 绑定视频元素的 timeupdate 和 seeked 事件监听器。
   */
  #attachEventListeners() {
    this.#videoEl.addEventListener("timeupdate", this.onTimeUpdate);
    this.#videoEl.addEventListener("seeking", this.onSeeking);
    this.#videoEl.addEventListener("seeked", this.onSeek);
  }

  /**
   * 移除事件监听器。
   */
  #removeEventListeners() {
    this.#videoEl.removeEventListener("timeupdate", this.onTimeUpdate);
    this.#videoEl.removeEventListener("seeking", this.onSeeking);
    this.#videoEl.removeEventListener("seeked", this.onSeek);
  }

  /**
   * 视频播放时间更新时的回调，负责同步当前字幕显示。
   */
  onTimeUpdate() {
    this.#syncToCurrentTime();
  }

  /**
   * 用户正在拖动进度条时的回调。
   */
  onSeeking() {
    this.#syncToCurrentTime({ forceRender: true });
  }

  /**
   * 用户拖动进度条后的回调。
   */
  onSeek() {
    this.#syncToCurrentTime({ forceRender: true });
  }

  #syncToCurrentTime({ forceRender = false } = {}) {
    const currentTimeMs = this.#videoEl.currentTime * 1000;
    const subtitleIndex = this.#findSubtitleIndexForTime(currentTimeMs);

    if (forceRender || subtitleIndex !== this.#currentSubtitleIndex) {
      this.#currentSubtitleIndex = subtitleIndex;
      this.#updateCaptionDisplay(
        subtitleIndex !== -1 ? this.#formattedSubtitles[subtitleIndex] : null
      );
    }
  }

  /**
   * 根据时间（毫秒）查找对应的字幕索引。
   * 使用二分查找，复杂度 O(log n)，替代原 findIndex 的 O(n)。
   * @param {number} currentTimeMs
   * @returns {number} 找到的字幕索引，-1 表示没找到。
   */
  #findSubtitleIndexForTime(currentTimeMs) {
    const arr = this.#formattedSubtitles;
    const len = arr.length;
    if (len === 0) return -1;

    if (currentTimeMs < arr[0].start || currentTimeMs > arr[len - 1].end) {
      return -1;
    }

    let left = 0;
    let right = len - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const sub = arr[mid];
      if (currentTimeMs >= sub.start && currentTimeMs <= sub.end) {
        return mid;
      } else if (currentTimeMs < sub.start) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    return -1;
  }

  /**
   * 更新字幕窗口的显示内容。
   * @param {object | null} subtitle - 字幕对象，或 null 用于清空。
   */
  #updateCaptionDisplay(subtitle) {
    if (!this.#paperEl || !this.#captionWindowEl) return;

    if (this.#isAdPlaying) {
      this.#paperEl.style.display = "none";
      return;
    }

    if (subtitle) {
      // 创建带有单词标记的字幕内容
      const p1 = document.createElement("p");
      p1.style.cssText = this.#setting.originStyle;
      p1.style.margin = "0";

      const isHoverLookupEnabled = this.#isHoverLookupEnabled();

      if (isHoverLookupEnabled) {
        trustedTypesHelper.setHTML(p1, this.#wrapWordsWithSpans(subtitle.text));
      } else {
        p1.textContent = truncateWords(subtitle.text);
      }

      const p2 = document.createElement("p");
      p2.style.cssText = this.#setting.translationStyle;
      p2.style.margin = "0";
      if (isHoverLookupEnabled) {
        trustedTypesHelper.setHTML(
          p2,
          this.#wrapWordsWithSpans(subtitle.translation || "...")
        );
      } else {
        p2.textContent = truncateWords(subtitle.translation) || "...";
      }

      if (this.#setting.isBilingual) {
        this.#captionWindowEl.replaceChildren(p2, p1);
      } else {
        this.#captionWindowEl.replaceChildren(p2);
      }

      if (this.#setting.blurTranslation) {
        const blurValue = "blur(6px)";
        p2.style.setProperty("filter", blurValue);
        p2.addEventListener("pointerenter", () => {
          p2.style.removeProperty("filter");
        });
        p2.addEventListener("pointerleave", () => {
          p2.style.setProperty("filter", blurValue);
        });
      }

      if (isHoverLookupEnabled) {
        this.#attachSpanListeners();
      }

      this.#paperEl.style.display = "block";
    } else {
      this.#paperEl.style.display = "none";
    }
  }

  // 将句子中的每个单词包装在span标签中
  #wrapWordsWithSpans(text) {
    // 使用正则表达式分割单词，保留空格和标点符号
    // 这个正则表达式匹配英文单词（包括带撇号的）
    return text.replace(
      /\b([a-zA-Z]+(?:'[a-zA-Z]+)?)\b/g,
      '<span class="babel-subtitle-word" data-word="$1">$1</span>'
    );
  }

  /**
   * 追加新的字幕
   * @param {Array<object>} newSubtitlesChunk - 新的、要追加的字幕数据块。
   */
  appendSubtitles(newSubtitlesChunk) {
    if (!newSubtitlesChunk || newSubtitlesChunk.length === 0) {
      return;
    }

    logger.info(
      `Bilingual Subtitle Manager: Appending ${newSubtitlesChunk.length} new subtitles...`
    );

    // 同一个数组引用，此处无需重复添加和排序
    // this.#formattedSubtitles.push(...newSubtitlesChunk);
    // this.#formattedSubtitles.sort((a, b) => a.start - b.start);
    this.#currentSubtitleIndex = -1;
    this.onTimeUpdate();

    // 新追加的字幕还没有译文，无需触发列表全量刷新
  }

  updateSetting(obj) {
    this.#setting = { ...this.#setting, ...obj };
  }

  // 获取当前字幕的开始时间（使用重新分段后的时间）
  #getCurrentSubtitleStartTime() {
    const currentTimeMs = this.#videoEl.currentTime * 1000;
    const idx = this.#findSubtitleIndexForTime(currentTimeMs);
    return idx !== -1 ? this.#formattedSubtitles[idx].start : currentTimeMs;
  }
}
