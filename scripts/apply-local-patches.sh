#!/bin/bash
# apply-local-patches.sh — Reapply local source-code customisations after upstream merges
#
# Run after `git merge upstream/main` or `git pull` to ensure local fixes are present.
#
# Patches applied:
#   1. Config symlink preservation in io.ts — prevents gateway from replacing
#      ~/.openclaw/openclaw.json symlink with a regular file on every restart.
#      Root cause: fs.rename(tmp, configPath) atomically replaces the symlink.
#      Fix: resolve symlinks via lstatSync/realpathSync before any writes.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

PATCHED=0
SKIPPED=0

echo "=== Applying local source-code patches ==="
echo ""

# ============================================================
# PATCH 1: Config symlink preservation (src/config/io.ts)
# ============================================================
IO_TS="$ROOT/src/config/io.ts"
SYMLINK_MARKER="// Follow symlinks so that writes go to the target file"

if [ ! -f "$IO_TS" ]; then
    echo "[1/1] ERROR: $IO_TS not found"
    exit 1
fi

if grep -qF "$SYMLINK_MARKER" "$IO_TS"; then
    echo "[1/1] Already applied: config symlink preservation (io.ts)"
    SKIPPED=$((SKIPPED + 1))
else
    echo "[1/1] Applying: config symlink preservation (io.ts)"
    python3 - "$IO_TS" <<'PYTHON_PATCH'
import sys, re

filepath = sys.argv[1]
with open(filepath, 'r') as f:
    code = f.read()

# Find the rawConfigPath assignment and inject symlink resolution after it
# Target pattern:
#   const rawConfigPath =
#     candidatePaths.find(...) ?? requestedConfigPath;
# We insert our symlink-following code right after that semicolon.

anchor = re.compile(
    r'(const rawConfigPath\s*=\s*\n\s*candidatePaths\.find\([^)]*\)\s*\?\?\s*requestedConfigPath;)'
)

match = anchor.search(code)
if not match:
    print("  WARNING: Could not find rawConfigPath assignment — io.ts structure may have changed")
    print("  Try applying manually: resolve symlinks before configPath is used for writes")
    sys.exit(1)

symlink_block = """
  // Follow symlinks so that writes go to the target file rather than
  // replacing the symlink with a regular file (see sypherin/openclaw#symlink-fix).
  let configPath = rawConfigPath;
  try {
    const stat = deps.fs.lstatSync(rawConfigPath);
    if (stat.isSymbolicLink()) {
      configPath = deps.fs.realpathSync(rawConfigPath);
    }
  } catch {
    // If lstat fails the file doesn't exist yet; keep the original path.
  }"""

insertion_point = match.end()
code = code[:insertion_point] + "\n" + symlink_block + code[insertion_point:]

with open(filepath, 'w') as f:
    f.write(code)

print("  Applied successfully")
sys.exit(0)
PYTHON_PATCH

    rc=$?
    if [ $rc -eq 0 ]; then
        PATCHED=$((PATCHED + 1))
    else
        echo "  FAILED to apply patch (exit code $rc)"
        exit 1
    fi
fi

echo ""
echo "=== Summary: $PATCHED patched, $SKIPPED already up-to-date ==="
