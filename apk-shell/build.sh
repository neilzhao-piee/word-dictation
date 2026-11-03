#!/usr/bin/env bash
# 构建安卓 APK（在本机构建，产出 word-dictation.apk）
# 前置：JDK 21、Android SDK（platforms;android-35 + build-tools;35.0.0 + platform-tools）、Node 20+
# 首次使用：若 android/ 目录不存在，先执行 `npx cap add android`（生成安卓工程），
# 然后在 android/local.properties 写入 sdk.dir=<你的 Android SDK 路径>，
# 并给 android/app/src/main/AndroidManifest.xml 的 <application> 加 android:usesCleartextTraffic="true"（允许局域网明文 HTTP）。
set -e
cd "$(dirname "$0")/.."

echo "==> 同步网页资源进壳工程"
rm -rf apk-shell/www && mkdir -p apk-shell/www/assets
cp static/index.html static/app.js static/style.css static/manifest.webmanifest apk-shell/www/
cp static/icon-192.png apk-shell/www/assets/icon.png
cp static/icon-512.png apk-shell/www/assets/splash.png

cd apk-shell
[ -d node_modules ] || npm install --no-fund --no-audit
[ -d android ] || npx cap add android
npx cap sync android

echo "==> gradle 构建"
cd android && ./gradlew assembleDebug --no-daemon
cp app/build/outputs/apk/debug/app-debug.apk ../word-dictation.apk
echo "==> 完成：apk-shell/word-dictation.apk"
