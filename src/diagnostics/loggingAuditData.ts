import type { LoggingAuditManifest } from './loggingAudit';

// 正式构建及测试构建由 logAuditPlugin 替换。缺少构建插件时显式报告审查不可用。
export default undefined as LoggingAuditManifest | undefined;
