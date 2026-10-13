export interface FileRef {
  path: string;
  line?: number;
  endLine?: number;
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
