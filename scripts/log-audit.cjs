const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');

// 语法检查只提供可复核的覆盖线索，不把任意 log 同名函数当作已落盘证明。
const logMethods = new Set(['appendLine', 'log', 'diagnostic', 'record', 'recordEvent']);
const operationMethods = new Set(['fetch', 'request', 'send', 'postMessage', 'writeFile', 'readFile', 'appendFile', 'rename',
  'unlink', 'mkdir', 'readdir', 'stat', 'open', 'spawn', 'exec', 'execFile', 'update', 'executeCommand']);
const callable = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
const callName = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : '';

function scanSource(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error(`日志覆盖审查无法解析 ${file}:${ast.getLineAndCharacterOfPosition(ast.parseDiagnostics[0].start).line + 1}`);
  const result = { file, sha256: createHash('sha256').update(source).digest('hex'), functions: 0, operations: 0, catches: 0, logSites: 0, candidates: [] };
  const lineOf = node => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const nameOf = node => {
    for (let p = node; p && p !== ast; p = p.parent) {
      if (p.name && ts.isIdentifier(p.name)) return p.name.text;
    }
    return '匿名回调';
  };
  const isLog = node => ts.isCallExpression(node) &&
    !(ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console') &&
    (logMethods.has(callName(node.expression)) ||
      callName(node.expression) === 'emit' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && ['diagnostic', 'log'].includes(node.arguments[0].text));
  // 不把未执行的嵌套回调/函数里的日志算在外层路径上。
  function facts(body) {
    const value = { log: false, operation: false, propagated: false };
    function visit(node) {
      if (node !== body && callable(node)) return;
      if (isLog(node)) value.log = true;
      if (ts.isAwaitExpression(node) || ts.isCallExpression(node) && operationMethods.has(callName(node.expression))) value.operation = true;
      if (ts.isThrowStatement(node) || ts.isCallExpression(node) && callName(node.expression) === 'reject') value.propagated = true;
      ts.forEachChild(node, visit);
    }
    visit(body); return value;
  }
  function inspectCatch(body, node) {
    result.catches++;
    const info = facts(body);
    if (!info.log) result.candidates.push({ line: lineOf(node), symbol: nameOf(node),
      kind: info.propagated ? 'error-propagated' : 'catch-unlogged' });
  }
  function visit(node) {
    if (isLog(node)) result.logSites++;
    if (callable(node) && node.body) {
      result.functions++;
      const info = facts(node.body);
      if (info.operation) {
        result.operations++;
        if (!info.log) result.candidates.push({ line: lineOf(node), symbol: nameOf(node), kind: 'operation-unlogged' });
      }
    }
    if (ts.isCatchClause(node)) inspectCatch(node.block, node);
    // 分支单独核验，不能用同一函数其他分支的一条日志掩盖未记录的操作。
    const branches = ts.isIfStatement(node) ? [node.thenStatement, node.elseStatement].filter(Boolean) :
      ts.isCaseClause(node) || ts.isDefaultClause(node) ? [node] : [];
    for (const branch of branches) {
      const info = facts(branch);
      if (info.operation && !info.log) result.candidates.push({ line: lineOf(branch), symbol: nameOf(node), kind: 'branch-unlogged' });
    }
    if (ts.isCallExpression(node)) {
      const method = callName(node.expression);
      if (['registerCommand', 'registerTextEditorCommand', 'addEventListener', 'on', 'once'].includes(method) || /^onDid[A-Z]/.test(method)) {
        const entry = /^onDid[A-Z]/.test(method) ? node.arguments[0] : node.arguments[1];
        if (entry && (!callable(entry) || !entry.body || !facts(entry.body).log)) {
          result.candidates.push({ line: lineOf(entry), symbol: nameOf(node), kind: 'entry-unlogged' });
        }
      }
      const handler = method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : undefined;
      if (handler) {
        if (callable(handler) && handler.body) inspectCatch(handler.body, handler);
        else {
          result.catches++;
          result.candidates.push({ line: lineOf(handler), symbol: nameOf(node), kind: 'handler-delegated' });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

function buildLogAudit(root) {
  const files = [], unsupported = [], watchDirs = [], watchFiles = [path.join(root, 'package.json')];
  function walk(dir) {
    watchDirs.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name), relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (/\.d\.ts$/.test(entry.name)) continue;
      if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
        files.push(scanSource(relative, fs.readFileSync(absolute, 'utf8'))); watchFiles.push(absolute);
      } else if (/\.(?:swift|m|mm|c|h|cpp|rs|go)$/.test(entry.name)) {
        unsupported.push(relative); watchFiles.push(absolute);
      }
    }
  }
  walk(path.join(root, 'src'));
  if (fs.existsSync(path.join(root, 'native'))) walk(path.join(root, 'native'));
  const manifest = { schema: 1, version: JSON.parse(fs.readFileSync(watchFiles[0], 'utf8')).version,
    sourceHash: createHash('sha256').update(JSON.stringify(files.map(f => [f.file, f.sha256]))).digest('hex'), files, unsupported };
  return { manifest, watchFiles, watchDirs };
}

// 与当前构建绑定，发布包无需源码或 TypeScript 运行时；watch 重建时同样重新审查。
function logAuditPlugin(root = path.resolve(__dirname, '..')) {
  return { name: 'log-coverage-audit', setup(build) {
    build.onLoad({ filter: /[/\\]loggingAuditData\.ts$/ }, () => {
      const { manifest, watchFiles, watchDirs } = buildLogAudit(root);
      return { contents: `export default ${JSON.stringify(manifest)};`, loader: 'js', watchFiles, watchDirs };
    });
  } };
}
module.exports = { scanSource, buildLogAudit, logAuditPlugin };
