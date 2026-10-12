const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 发布包同时包含 Apple Silicon 和 Intel macOS 代码，收件机器无需 Xcode/Swift。
if (process.platform !== 'darwin') throw new Error('发布本机通知组件需要在 macOS 上运行 npm run package。');
const root = path.resolve(__dirname, '..');
const contents = path.join(root, 'dist', 'Codex Copilot Notifications.app', 'Contents');
const macos = path.join(contents, 'MacOS');
fs.mkdirSync(macos, { recursive: true });
const version = require('../package.json').version;
fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.blackrock1121.codex-copilot.notifications</string>
<key>CFBundleName</key><string>Codex Copilot Notifications</string>
<key>CFBundleDisplayName</key><string>Codex Copilot Notifications</string>
<key>CFBundleExecutable</key><string>codex-notifications</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>LSUIElement</key><true/>
<key>CFBundleDocumentTypes</key><array><dict>
<key>CFBundleTypeName</key><string>Codex Notification Request</string>
<key>CFBundleTypeExtensions</key><array><string>codex-notification</string></array>
<key>CFBundleTypeRole</key><string>Viewer</string>
<key>LSHandlerRank</key><string>Alternate</string>
</dict></array>
</dict></plist>`);
const temp = fs.mkdtempSync(path.join(root, 'dist', 'native-build-'));
try {
  for (const arch of ['arm64', 'x86_64']) {
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx11.0`,
      path.join(root, 'native', 'Notifications.swift'), '-o', path.join(temp, arch)], { stdio: 'inherit' });
  }
  execFileSync('xcrun', ['lipo', '-create', path.join(temp, 'arm64'), path.join(temp, 'x86_64'),
    '-output', path.join(macos, 'codex-notifications')], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path.dirname(contents)], { stdio: 'inherit' });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('本机通知组件构建完成（arm64 + x86_64）。');
