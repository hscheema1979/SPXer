#!/bin/bash
# Wrapper for verify-metric that bundles first to avoid tsx/better-sqlite3 hang

set -e

# Change to project directory so relative paths work
cd "$(dirname "$0")/../.."

# Bundle to temp file
BUNDLE="/tmp/verify-metric-$$.bundle.js"
npx esbuild scripts/autoresearch/verify-metric.ts --bundle --platform=node --outfile="$BUNDLE" --sourcemap > /dev/null

# Run the bundle
node "$BUNDLE" "$@"

# Cleanup
rm -f "$BUNDLE"
