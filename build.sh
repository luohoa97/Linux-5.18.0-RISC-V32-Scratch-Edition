#!/usr/bin/env bash
set -e
echo "==> Bundling..."
npx tsx bundler.ts ./src ./stage.gs
echo "==> Compiling..."
goboscript build
echo "==> Done!"