// 查看、询问进度和引用过往指令时，保留原会话资源，只有明确请求才建立传输。
export function hasExplicitThreadFileSaveIntent(message: string): boolean {
  const text = message
    .normalize("NFKC")
    .replace(/```[\s\S]*?```|`[^`\n]*`|「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const deniedZh =
    /(?:别|不(?:要|用|必|需要|想)|无需|禁止|暂不)(?:再|帮我|给我|替我|进行|自动|实际|把[^，。！？,!?]{1,28})*(?:下载|保存|存到|另存|传送|传到|发到|发送到|复制到)/u;
  const deniedEn =
    /\b(?:don't|don’t|do not|never|no need to|without|avoid)\b[^.!?;]{0,65}\b(?:save|download|send|transfer|copy)\b/iu;
  if (deniedZh.test(text) || deniedEn.test(text)) return false;
  return text.split(/[，。！？、,.!?;；]/u).some((sentence) => {
    const clause = sentence.trim();
    const chineseInquiry =
      /^(?:(?:请|帮我|给我|替我)\s*)?(?:看看|看一看|查(?:询|看|一下)|检查|确认|告诉我|是否|有没有|如何|怎么|什么时候|多久)/u;
    if (chineseInquiry.test(clause)) return false;
    const saveZh =
      /^(?:(?:请|请你|麻烦|帮我|给我|替我|能不能|可以(?:帮我)?|先|直接|现在)\s*)*(?:把[^，。！？,.!?]{1,60}|(?:刚才|上面|这|那)[^，。！？,.!?]{0,25}(?:张|图|份|件|文件|附件))?\s*(?:下载|保存|另存|存到|存进)(?!了|完|好|成功|失败|过|后)(?:\s*$|(?:到|至|为|刚才|上述|上面|这|那|一份|一下|文件|附件|原图|在|我|本机))/u;
    const transferZh =
      /^(?:(?:请|请你|帮我|给我|替我|先|现在)\s*)*(?:把[^，。！？,.!?]{1,60})?(?:传到|传给|发送到|发到|复制到)[^，。！？,.!?]{0,35}(?:设备|电脑|PC|手机|安卓|平板|桌面|下载|Windows|Mac|K60|K90)/iu;
    const englishRequest = clause.replace(/^(?:(?:please|(?:could|can|would|will) you)\s+)*/iu, "");
    const saveEn =
      /^(?:save|download)(?:\s+(?:it\b|this\b|that\b|the\b|a copy\b|my\b|our\b|to\b|onto\b)|\s*$)/iu;
    const transferEn =
      /^(?:send|transfer|copy)\b[^.!?;]{0,80}\b(?:to|onto)\b[^.!?;]{0,40}\b(?:device|pc|computer|phone|desktop|tablet|android|windows|mac)\b/iu;
    return (
      saveZh.test(clause) ||
      transferZh.test(clause) ||
      saveEn.test(englishRequest) ||
      transferEn.test(englishRequest)
    );
  });
}
