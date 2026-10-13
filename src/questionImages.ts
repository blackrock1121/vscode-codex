export interface AnswerImage { mediaType: string; data: string }
export type QuestionImages = Record<string, AnswerImage[]>;
export const QUESTION_IMAGE_ANSWER = '（见附图）';
export const QUESTION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const QUESTION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 前后端共用，先验证全部附件再提交，避免只发送文字却丢掉图片。 */
export function validateQuestionImages(images: QuestionImages = {}): void {
  if (!images || typeof images !== 'object' || Array.isArray(images)) throw new Error('图片附件格式无效');
  let count = 0, bytes = 0;
  for (const list of Object.values(images)) {
    if (!Array.isArray(list)) throw new Error('图片附件格式无效');
    for (const image of list) {
      if (++count > 10) throw new Error('一次回答最多添加 10 张图片');
      if (!image || !QUESTION_IMAGE_TYPES.includes(image.mediaType)) throw new Error('图片仅支持 PNG、JPEG、WebP 和 GIF');
      if (typeof image.data !== 'string' || !image.data.length || image.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error('图片数据无效，请重新添加');
      const size = image.data.length / 4 * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
      if (size > QUESTION_IMAGE_MAX_BYTES) throw new Error('单张图片不能超过 10 MB');
      bytes += size;
      if (bytes > 20 * 1024 * 1024) throw new Error('一次回答的图片总量不能超过 20 MB');
    }
  }
}
