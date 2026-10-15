/** 日志摘要进入页面、诊断记录和模型前统一脱敏；不复制完整命令、正文或凭据。 */
export function redactDiagnosticText(input: string, limit = 400): string {
  return input.slice(0, 32768)
    .replace(/(["'](?:prompt|input|messages|content|command|output|body)["']\s*:)\s*.+$/gi, '$1[内容已隐藏]')
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi, '[URL]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w-]*)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[已隐藏]')
    .replace(/(?:\/[A-Za-z0-9_.@-]+){2,}(?:\/[^\s"'<>|]*)?/g, '[路径]')
    .replace(/[A-Z]:\\(?:[^\s"'<>]+\\)*[^\s"'<>]*/gi, '[路径]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱]')
    .replace(/[\r\n\t\u0000-\u001f]+/g, ' ').slice(0, limit);
}
