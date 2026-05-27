#!/usr/bin/env bash
# fix-hook-circular-deps.sh
#
# Fixes the __exportAll circular dependency in the hooks chunk graph
# produced by tsdown. The hooks entry group creates separate chunks
# where pi-embedded-*.js and its consumers form a circular import,
# causing __exportAll to be undefined at module evaluation time.
#
# This script:
# 1. Creates a standalone __exportAll.js module
# 2. Redirects all affected files to import from it
#
# Run after: pnpm build
# See: https://github.com/openclaw/openclaw/issues/13662

set -euo pipefail

DIST_DIR="$(cd "$(dirname "$0")/.." && pwd)/dist"

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: dist/ directory not found at $DIST_DIR" >&2
  exit 1
fi

# Find ALL pi-embedded chunks that define __exportAll
PI_CHUNKS=$(grep -l 'var __exportAll' "$DIST_DIR"/pi-embedded-*.js 2>/dev/null || true)

if [ -z "$PI_CHUNKS" ]; then
  echo "SKIP: No pi-embedded chunk with __exportAll found (may already be fixed upstream)"
  exit 0
fi

# Extract the __exportAll + __defProp helper as a standalone module
cat > "$DIST_DIR/__exportAll.js" << 'HELPER_EOF'
// Extracted to break circular dependency in hooks chunk graph
// See: https://github.com/openclaw/openclaw/issues/13662
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) {
		__defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	}
	if (!no_symbols) {
		__defProp(target, Symbol.toStringTag, { value: "Module" });
	}
	return target;
};
export { __exportAll };
HELPER_EOF

# Redirect ALL imports of __exportAll from any chunk to __exportAll.js.
# Uses find to cover subdirectories (plugin-sdk/, bundled/, etc.) and handles
# both relative paths ("./chunk-*", "../reply-*", "./pi-embedded-*", etc.).
COUNT=0
while IFS= read -r f; do
  # Skip __exportAll.js itself
  [ "$(basename "$f")" = "__exportAll.js" ] && continue
  # Compute the relative path from the file's directory to $DIST_DIR/__exportAll.js
  FILE_DIR=$(dirname "$f")
  REL_PREFIX=$(python3 -c "import os.path; print(os.path.relpath('$DIST_DIR', '$FILE_DIR'))")
  REPLACEMENT="import { __exportAll } from \"${REL_PREFIX}/__exportAll.js\";"
  # Replace any: import { XX as __exportAll } from "./anything.js";
  if sed -i -E "s|import \{ [A-Za-z0-9_]+ as __exportAll \} from \"[^\"]*\.js\";|${REPLACEMENT}|g" "$f"; then
    COUNT=$((COUNT + 1))
    echo "  Fixed: $(basename "$f")"
  fi
done < <(grep -rl 'as __exportAll' "$DIST_DIR" --include='*.js' 2>/dev/null || true)

echo "Done: patched $COUNT files, created __exportAll.js"
