// 查看、询问进度和引用过往指令时，保留原会话资源，只有明确请求才建立传输。
export function hasExplicitThreadFileSaveIntent(message: string): boolean {
  const text = message
    .normalize("NFKC")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`|「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/gu, (quoted) =>
      /保存|下载|发到|传到|\b(?:save|download|send|transfer)\b/iu.test(quoted)
        ? " "
        : quoted.slice(1, -1),
    )
    .replace(/\s+/gu, " ")
    .trim();
  const deniedZh =
    /(?:别|不(?:要|用|必|需要|想)|无需|禁止|暂不)(?:再|帮我|给我|替我|进行|自动|实际|把[^，。！？,!?]{1,28})*(?:下载|保存|存到|另存|传送|传到|传给|发到|发给|发送到|发送给|发过来|传过来|复制到)/u;
  const deniedEn =
    /\b(?:don't|don’t|do not|never|no need to|without|avoid)\b[^.!?;]{0,65}\b(?:save|download|send|transfer|copy)\b/iu;
  if (deniedZh.test(text) || deniedEn.test(text)) return false;
  return text
    .split(
      /[，。！？、,!?;；]|\.(?=\s|$)|(?:然后|接着|并且|最后|再)(?=\s*(?:发到|传到|发送到|发过来|传过来|保存|下载|存到))|\b(?:and then|then)\b/iu,
    )
    .some((sentence) => {
      const clause = sentence.trim();
      const chineseInquiry =
        /^(?:(?:请|帮我|给我|替我)\s*)?(?:看看|看一看|查(?:询|看|一下)|检查|确认|告诉我|是否|有没有|如何|怎么|什么时候|多久)/u;
      if (chineseInquiry.test(clause)) return false;
      const saveZh =
        /^(?:(?:请|请你|麻烦|帮我|给我|替我|能不能|可以(?:帮我)?|先|直接|现在)\s*)*(?:把[^，。！？,!?]{1,60}|(?:刚才|上面|这|那)[^，。！？,!?]{0,25}(?:张|图|份|件|文件|附件))?\s*(?:下载|保存|另存|存到|存进)(?!了|完|好|成功|失败|过|后)(?:\s*$|(?:到|至|为|刚才|上述|上面|这|那|一份|一下|文件|附件|原图|在|我|本机))/u;
      const transferZh =
        /^(?:(?:请|请你|帮我|给我|替我|先|现在)\s*)*(?:把[^，。！？,!?]{1,100})?(?:传到|传给|发送到|发送给|发到|发给|复制到|保存到|另存到|下载到|存到|存进)(?!\s*我(?:看看|看一下|预览))\s*[^，。！？,!?\s]/iu;
      const transferHereZh =
        /^(?:(?:请|请你|帮我|给我|替我|先|现在)\s*)*(?:把[^，。！？,!?]{1,100})?(?:发过来|传过来)(?:一下|给我)?$/u;
      const englishRequest = clause.replace(
        /^(?:(?:please|(?:could|can|would|will) you)\s+)*/iu,
        "",
      );
      const saveEn =
        /^(?:save|download)(?:\s+(?:it\b|this\b|that\b|the\b|a copy\b|my\b|our\b|to\b|onto\b)|\s*$)/iu;
      const transferEn =
        /^(?:send|transfer|copy)\b[^!?;]{0,120}\b(?:to|onto)\s+(?!me\s+(?:so|for|to)\b)\S/iu;
      return (
        saveZh.test(clause) ||
        transferZh.test(clause) ||
        transferHereZh.test(clause) ||
        saveEn.test(englishRequest) ||
        transferEn.test(englishRequest)
      );
    });
}

export type ThreadFileDestination =
  | { readonly kind: "current"; readonly device: "mobile" | "desktop" | "any" }
  | { readonly kind: "named"; readonly label: string }
  | { readonly kind: "unclear" };

export function threadFileDestination(message: string): ThreadFileDestination {
  if (!hasExplicitThreadFileSaveIntent(message)) return { kind: "unclear" };
  const text = message.normalize("NFKC").toLocaleLowerCase();
  const chinese = [
    ...text.matchAll(
      /(?:发(?:送)?|传(?:送)?|复制|保存|另存|下载)(?:到|给|至)|(?:存到|存进|发过来|传过来)/gu,
    ),
  ];
  const english = [
    ...text.matchAll(
      /\b(?:send|transfer|copy|save|download)\b[^.!?；。]{0,160}?\b(?:to|onto)\s+/giu,
    ),
  ];
  const destinations = [...chinese, ...english];
  if (destinations.length !== 1) return { kind: "unclear" };
  const command = destinations[0]!;
  const remainder = text.slice(command.index + command[0].length).trim();
  if (command[0] === "发过来" || command[0] === "传过来") {
    return /^(?:一下|给我|吧|谢谢)?[.!?。！？]*$/u.test(remainder)
      ? { kind: "current", device: "any" }
      : { kind: "unclear" };
  }
  if (/或(?:者)?|还是|(?:也可以|也行)|、|\b(?:and|or|either|maybe)\b/u.test(remainder)) {
    return { kind: "unclear" };
  }
  const label = remainder
    .replace(/(?:[，,。.!?！？]+\s*)?(?:谢谢|thanks|please)\s*[。.!?！？]*$/u, "")
    .replace(/[。.!?！？]+$/u, "")
    .trim()
    .replace(/^(?:「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)")$/u, "$1$2$3$4")
    .trim();
  if (
    /^(?:这台(?:设备|终端)?|本机|当前(?:设备|终端)|我这台(?:设备|终端)?|我的(?:设备|终端))$|^(?:(?:this|my) (?:device|client)|here)$/u.test(
      label,
    )
  ) {
    return { kind: "current", device: "any" };
  }
  if (
    /^(?:这台|本机|当前|我这台|我的)(?:手机|安卓|平板)(?:上)?$|^(?:this|my) (?:phone|android|tablet)$/u.test(
      label,
    )
  ) {
    return { kind: "current", device: "mobile" };
  }
  if (
    /^(?:这台|本机|当前|我这台|我的)(?:电脑|桌面|pc|mac)(?:上)?$|^(?:this|my) (?:computer|desktop|pc|mac)$/u.test(
      label,
    )
  ) {
    return { kind: "current", device: "desktop" };
  }
  return label ? { kind: "named", label } : { kind: "unclear" };
}
