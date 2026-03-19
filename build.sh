#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Install types if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dev dependencies..."
  npm install
fi

# Compile TypeScript
echo "Compiling TypeScript..."
npx tsc

# Copy static assets to dist
echo "Copying static assets..."
cp -r static/* dist/ 2>/dev/null || true
cp manifest.json dist/

echo "Build complete → dist/"
