import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';

/** 图片读取限制实际读入量；文件在 stat 后增长也不能突破内存预算。 */
export async function readImageFile(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('图片不是普通文件'), { code: 'EINVAL' });
    if (stat.size > maxBytes) throw Object.assign(new Error('图片超过大小限制'), { code: 'EFBIG' });
    const chunks: Buffer[] = []; let size = 0;
    while (size <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(chunks, size);
      size += bytesRead;
      if (size > maxBytes) throw Object.assign(new Error('图片超过大小限制'), { code: 'EFBIG' });
      chunks.push(buffer.subarray(0, bytesRead));
    }
    throw Object.assign(new Error('图片超过大小限制'), { code: 'EFBIG' });
  } finally { await handle.close(); }
}
