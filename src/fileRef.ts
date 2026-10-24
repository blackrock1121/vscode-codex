export interface FileRef {
  path: string;
  line?: number;
  endLine?: number;
}

/** Windows 盘符路径以冒号开头，但不是 URI scheme。 */
export function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value);
}

/** URI scheme 判断排除 C:\\... / C:/... 盘符路径。 */
export function hasUriScheme(value: string): boolean {
  return !isWindowsAbsolutePath(value) && /^[a-z][a-z\d+.-]*:/i.test(value);
}

/** 将 file URI 转为适用于 Windows 的盘符路径或 UNC 路径。 */
export function fileUriToPath(value: string | URL): string | undefined {
  try {
    const uri = value instanceof URL ? value : new URL(value);
    if (uri.protocol !== "file:") return undefined;
    const pathname = decodeURIComponent(uri.pathname);
    if (uri.hostname) return `//${uri.hostname}${pathname}`;
    return pathname.replace(/^\/([a-z]:\/)/i, "$1");
  } catch {
    return undefined;
  }
}

/** 在 URI 解码前分离位置，供链接渲染、存在性校验和打开文件共用。 */
export function parseFileRef(value: string): FileRef {
  const ref = value.trim();
  const hash = /^(.+?)#L?(\d+)(?:[-–]L?(\d+))?$/.exec(ref);
  // :行:列 中的列不当成结束行；当前编辑器跳转选中整行。
  const colon = hash ? null : /^([^#?]+?):(\d+)(?:[-–](\d+)|:\d+)?$/.exec(ref);
  const match = hash ?? colon;
  return match ? {
    path: match[1],
    line: Number(match[2]),
    endLine: match[3] ? Number(match[3]) : undefined,
  } : { path: ref };
}
