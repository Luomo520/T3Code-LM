// 只接受独立的祈使句，避免把讨论、转述、否定、示例及附件正文误作本次授权。
export function matchesRecordingRequest(text: string, names: readonly string[], seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30 || text.length > 512) return false;
  const digits = "零一二三四五六七八九";
  const tens = Math.floor(seconds / 10);
  const chinese =
    tens === 0
      ? digits[seconds]
      : (tens > 1 ? digits[tens] : "") + "十" + (seconds % 10 ? digits[seconds % 10] : "");
  const duration = seconds === 2 ? "(?:2|二|两)" : "(?:" + seconds + "|" + chinese + ")";
  return names.filter(Boolean).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const target = "(?:" + escaped + "|「" + escaped + "」)";
    const interval = "\\s*" + duration + "\\s*秒";
    const zh =
      "(?:请|帮我|请帮我)?\\s*(?:录制|录屏|录)\\s*" +
      target +
      "(?:的屏幕)?" +
      (seconds === 10 ? "(?:" + interval + ")?" : interval) +
      "(?:给我看(?:看)?|发给我)?";
    const enTime = "\\s+for\\s+" + seconds + "\\s+seconds?";
    const en =
      "(?:please\\s+)?record\\s+" + target + (seconds === 10 ? "(?:" + enTime + ")?" : enTime);
    return new RegExp("^(?:" + zh + "|" + en + ")[。.!！]?$", "iu").test(text.trim());
  });
}
