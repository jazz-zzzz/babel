import { useCallback, useMemo, useState } from "react";

// 单行文本溢出省略标签组件
function Label({ children }) {
  return (
    <div
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

// 菜单单项组件，支持鼠标 hover 时的背景高亮和透明度变化过渡效果
function MenuItem({ children, onClick, disabled = false }) {
  const [hover, setHover] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0px 8px",
        opacity: hover ? 1 : 0.8,
        background: `rgba(255, 255, 255, ${hover ? 0.1 : 0})`,
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.2s, opacity 0.2s",
        borderRadius: 5,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

// 开关 (Toggle Switch) 菜单组件
function Switch({ label, name, value, onChange, disabled }) {
  // REVIEW: 这里的 handleClick 依赖了 value。当每次开关被点击切换时，value 会随之改变，
  // 导致该 useCallback 重新生成并返回新的函数引用，使得 useCallback 并没有起到缓存函数引用的效果。
  const handleClick = useCallback(() => {
    if (disabled) return;

    onChange({ name, value: !value });
  }, [disabled, onChange, name, value]);

  return (
    <MenuItem onClick={handleClick} disabled={disabled}>
      <Label>{label}</Label>
      {/* 轨道 */}
      <div
        style={{
          width: 40,
          height: 24,
          borderRadius: 12,
          background: value ? "rgba(32,156,238,.8)" : "rgba(255,255,255,.3)",
          position: "relative",
        }}
      >
        {/* 滑块 */}
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            position: "absolute",
            left: 2,
            top: 2,
            background: "rgba(255,255,255,.9)",
            transform: `translateX(${value ? 16 : 0}px)`,
          }}
        ></div>
      </div>
    </MenuItem>
  );
}

// 简单按钮点击项组件
function Button({ label, onClick, disabled }) {
  const handleClick = useCallback(() => {
    if (disabled) return;

    onClick();
  }, [disabled, onClick]);

  return (
    <MenuItem onClick={handleClick} disabled={disabled}>
      <Label>{label}</Label>
    </MenuItem>
  );
}

/**
 * 视频字幕设置快捷菜单面板组件（用于在视频网页内浮现，控制 AI 翻译和分句选项）
 */
export function Menus({
  i18n,
  formData,
  progressed = 0,
  updateSetting,
  downloadSubtitle,
}) {
  // 处理任何字段选项的变化
  const handleChange = useCallback(
    ({ name, value }) => {
      updateSetting({ name, value });
    },
    [updateSetting]
  );

  // 计算当前的字幕处理/下载状态描述语
  const status = useMemo(() => {
    if (progressed === 0) return i18n("waiting_subtitles");
    if (progressed === 100) return i18n("download_subtitles");
    return i18n("processing_subtitles");
  }, [progressed, i18n]);

  // 解构字幕相关的表单值数据
  const { skipAd, isBilingual, blurTranslation, showOrigin } = formData;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        bottom: 100,
        background: "rgba(0,0,0,.6)",
        width: 250,
        lineHeight: "40px",
        fontSize: 16,
        padding: 8,
        borderRadius: 5,
      }}
    >
      <Switch
        onChange={handleChange}
        name="isBilingual"
        value={isBilingual}
        label={i18n("is_bilingual_view")}
      />
      <Switch
        onChange={handleChange}
        name="blurTranslation"
        value={blurTranslation}
        label={i18n("is_blur_translation")}
      />
      <Switch
        onChange={handleChange}
        name="showOrigin"
        value={showOrigin}
        label={i18n("show_origin_subtitle")}
      />
      <Switch
        onChange={handleChange}
        name="skipAd"
        value={skipAd}
        label={i18n("is_skip_ad")}
      />
      <Button
        label={`${status} [${progressed}%] `}
        onClick={downloadSubtitle}
        disabled={progressed !== 100}
      />
    </div>
  );
}
