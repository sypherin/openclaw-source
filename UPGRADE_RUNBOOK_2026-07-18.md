# OpenClaw Upgrade Runbook: 2026.5.26 -> 2026.7.1

Prepared 2026-07-18 (SGT). Everything below the "Cutover" heading is the only part
that touches the running service. All prep is DONE and verified; cutover is a
copy-paste operation targeting under 5 minutes of downtime.

## What is already staged and verified (no action needed)

| Item | State | How verified |
|---|---|---|
| Node v24.18.0 (userspace, nvm) | `~/.nvm/versions/node/v24.18.0` | `node -v` from that path; satisfies 7.1 engines `>=24.15.0 <25` |
| User shell node untouched | still `/usr/bin/node` v22.22.2 | `bash -lc 'node -v; which node'` after install; no nvm `default` alias was created |
| Worktree at tag | `~/openclaw-2026.7.1` @ v2026.7.1 (2d2ddc43d0d), detached HEAD | `git worktree list`; `~/openclaw-source` stays on main @ e0f0f7dce5c, working tree clean |
| Dependencies | `pnpm install --frozen-lockfile` clean (21.7s) | pnpm 11.2.2 exactly matches `packageManager` |
| Build | `pnpm build` PASS, exit 0 (242s) | `dist/index.js` present |
| Binary runs on node 24 | prints `OpenClaw 2026.7.1 (2d2ddc4)` | ran sandboxed (fake HOME); wrote nothing outside sandbox |
| Old node refuses 7.1 | clear engines error under /usr/bin/node 22.22.2 | ran it; this is why units must switch node paths |
| Gateway boots | sandboxed boot reaches config stage, exits "Missing config" | full boot deliberately NOT tested against live config (a second gateway with the real Telegram token would fight the live poller). Skipped on purpose |
| Live config is 7.1-valid | `config validate` on a COPY of `~/.openclaw/openclaw.json`: VALID, 1 benign warning (disabled brave plugin config present) | isolated env, copy deleted after |
| wa-health watchdog stays functional | "Listening for WhatsApp" exists in 7.1 (`extensions/whatsapp/src/auto-reply/monitor/listener-log.ts`); "restarting (reason: ..." exists (`src/gateway/channel-health-monitor.ts`) | git grep at tag |
| New unit files | `~/openclaw-2026.7.1/cutover/openclaw-{gateway,node}.service` | diff vs current units = exactly 4 lines each (Description, ExecStart node+dist path, PATH prepend, OPENCLAW_SERVICE_VERSION); pass `systemd-analyze --user verify` |
| Rollback unit copies | `~/openclaw-2026.7.1/cutover/*.service.bak` (verbatim current units, mode 600, contain secrets) | copied today |
| CLI wrapper | `~/openclaw-2026.7.1/cutover/openclaw-cli-wrapper.sh` | needed because interactive shells only have node 22.22.2; 7.1 CLI refuses it |

Current launch topology (confirmed today):
- `openclaw-gateway.service` (systemd --user): `/usr/bin/node ~/.npm-global/lib/node_modules/openclaw/dist/index.js gateway --port 18789`, and that npm path is a symlink to `~/openclaw-source`
- `openclaw-node.service` (systemd --user): `/usr/bin/node ~/openclaw-source/dist/index.js node run --host 127.0.0.1 --port 18789` (KillMode=process, so check for orphans after stop)
- `openclaw-watchdog.service` (systemd --user): `~/.openclaw/watchdog.sh`, alert-only via Telegram
- `wa-health-watchdog.timer`: runs `~/bin/wa-health-watchdog.sh` every ~10 min, alert-only
- CLI: `~/.npm-global/bin/openclaw` -> symlink -> `openclaw.mjs` in the symlinked tree

## DECISION GATE before cutover: local patches are NOT ported

`~/openclaw-2026.7.1` is VANILLA upstream v2026.7.1. Main (the running build) carries
the local patch set from commit 28fcddeb (see `~/openclaw-source/LOCAL_PATCHES.md`).

Risk-reducing facts (verified today):
- All custom providers the live routing uses (zai via `https://api.z.ai/api/anthropic`,
  nvidia-qwen / nvidia-glm / nvidia-glm5 / nvidia-step / nvidia-kimi-k2 / nvidia-deepseek,
  local-llama :8001, lemonade, local-npu, moonshot) are defined in
  `~/.openclaw/openclaw.json` as custom providers with explicit baseUrl + api type.
  7.1 validates that config unchanged.
- Upstream 7.1 now ships `extensions/nvidia`, `extensions/zai`, `extensions/moonshot`,
  `extensions/kimi-coding`, `extensions/minimax`, so part of the fork work was upstreamed.

Fork-only pieces that vanilla 7.1 will NOT have (not deep-diffed against upstream;
some may have been absorbed):
1. `scripts/apply-pi-ai-patches.sh` (8 pi-ai fixes: GLM empty tool-call filter, Kimi
   reasoning-to-text fallback, 120s request timeout, tool-call ID normalization,
   XML tool-call parser, reasoning_content strip, global API key fallback)
2. GLM `<tool_call>` XML repair wiring in `attempt.ts` + zai exclusion (the exclusion
   was a compiled `dist/` line edit; it dies with any rebuild)
3. Qwen `/no_think` injection, smart routing classifier, heartbeat pruning,
   normalize-reply thinking-strip + fixFlattenedMarkdown, WhatsApp media reply
   normalization, prompt-injection guardrails, RateLimiter leak fix,
   non-admin status redaction

Failure signatures if these turn out to matter: raw `<tool_call>` XML or JSON blobs
in channel replies, empty Kimi replies, garbage tool_calls from GLM, "missing API key"
errors on nvidia-* providers, thinking tags leaking into WhatsApp/Telegram messages.

Options:
- A (fast): cut over vanilla, watch for the signatures above for a few hours, port
  patches later only if symptoms appear. Rollback is 3 minutes if it is bad.
- B (safe): port the patch set onto a branch from v2026.7.1 first, rebuild the
  worktree, rerun the verification steps in the table above, then cut over.

Pick one before proceeding. If in doubt: A, with the journal tail open.

## Cutover (copy-paste; target < 5 min downtime)

Pre-checks, zero downtime:

```bash
# staged assets present?
ls -l ~/openclaw-2026.7.1/cutover/
# wa-health timer just fired? (want ~8-10 min until next fire so it cannot race the cutover)
systemctl --user list-timers | grep wa-health
# open a SECOND terminal with the journal tail and keep it visible:
journalctl --user -u openclaw-gateway -f
```

Step 1: stop services (watchdog FIRST so it cannot alert on the intentional stop). ~15s

```bash
systemctl --user stop openclaw-watchdog.service
systemctl --user stop openclaw-gateway.service openclaw-node.service
```

Step 2: orphan check (node unit uses KillMode=process). ~5s

```bash
pgrep -af 'openclaw-node|openclaw.*dist/index.js' || echo "clean"
# if anything is listed: kill <pid> and re-check
```

Step 3: state backup while everything is stopped (~30-60s; excludes the 1.8G
browser profile; ~/.openclaw is 2.1G total, 230M without it):

```bash
tar --zstd -cf ~/openclaw-preupgrade-$(date +%Y%m%d-%H%M).tar.zst \
  --exclude='.openclaw/browser' \
  -C /home/awpapa .openclaw .openclaw-config/agents/main/sessions
ls -lh ~/openclaw-preupgrade-*.tar.zst   # expect a few hundred MB
```

Step 4: swap units + CLI. ~10s

```bash
cp ~/openclaw-2026.7.1/cutover/openclaw-gateway.service ~/.config/systemd/user/openclaw-gateway.service
cp ~/openclaw-2026.7.1/cutover/openclaw-node.service    ~/.config/systemd/user/openclaw-node.service
ln -sfn ../../../openclaw-2026.7.1 ~/.npm-global/lib/node_modules/openclaw
install -m 755 ~/openclaw-2026.7.1/cutover/openclaw-cli-wrapper.sh ~/.npm-global/bin/openclaw
systemctl --user daemon-reload
```

Step 5: start. ~10s + reconnect time

```bash
systemctl --user start openclaw-gateway.service
systemctl --user start openclaw-node.service
systemctl --user start openclaw-watchdog.service
```

Step 6: health checks (~2 min, see next section). WhatsApp reconnect normally
appears in the journal within 60-90s of gateway start.

## Health checks (run all; expected result on each)

```bash
# 1. units running
systemctl --user --no-pager status openclaw-gateway openclaw-node openclaw-watchdog | grep -E 'Active:'
#    expect: three lines "active (running)"

# 2. gateway port
ss -ltn | grep 18789
#    expect: LISTEN on 127.0.0.1:18789 and [::1]:18789

# 3. CLI + version
openclaw --version
#    expect: OpenClaw 2026.7.1 (2d2ddc4)

# 4. gateway + channel health (7.1 has both)
openclaw health
openclaw status
#    expect: healthy gateway; whatsapp + telegram channels connected

# 5. WhatsApp reconnect watch (in the journal-tail terminal)
#    expect within ~90s of start: "Listening for WhatsApp inbound messages ..."
#    if the line is missing after 3 min AND ~/.openclaw/credentials/whatsapp/default/creds.json
#    is missing or empty -> session lost, relink: openclaw channels login --channel whatsapp

# 6. wa-health watchdog agrees
~/bin/wa-health-watchdog.sh
#    expect: "UP"

# 7. tailscale unaffected (upgrade should not touch it; confirm anyway)
tailscale status | head -5
#    expect: this box + peers listed, no "stopped" state

# 8. end-to-end: send a Telegram message to the bot from the phone
#    expect: normal reply, and sessions.json mtime advances:
stat -c '%y' ~/.openclaw-config/agents/main/sessions/sessions.json

# 9. migration awareness (affects rollback, see below)
journalctl --user -u openclaw-gateway --since "-10 min" --no-pager | grep -iE 'migrat|upgrad' || echo "no migrations logged"

# 10. watch the next hour for local-patch failure signatures
#     (XML fragments in replies, empty Kimi replies, nvidia-* key errors)
```

## Rollback (to exactly the pre-upgrade state, main @ e0f0f7d) ~2-3 min

`~/openclaw-source` was never modified (still main @ e0f0f7dce5c with committed
`dist/`), so rollback is config-level only, no rebuild:

```bash
systemctl --user stop openclaw-watchdog.service openclaw-gateway.service openclaw-node.service

cp ~/openclaw-2026.7.1/cutover/openclaw-gateway.service.bak ~/.config/systemd/user/openclaw-gateway.service
cp ~/openclaw-2026.7.1/cutover/openclaw-node.service.bak    ~/.config/systemd/user/openclaw-node.service
ln -sfn ../../../openclaw-source ~/.npm-global/lib/node_modules/openclaw
ln -sfn ../lib/node_modules/openclaw/openclaw.mjs ~/.npm-global/bin/openclaw
systemctl --user daemon-reload

# ONLY if health check 9 showed a state migration during the 7.1 boot:
#   mv ~/.openclaw ~/.openclaw.broken-7.1
#   tar --zstd -xf ~/openclaw-preupgrade-<STAMP>.tar.zst -C /home/awpapa
#   mv ~/.openclaw.broken-7.1/browser ~/.openclaw/browser   # browser dir was excluded from backup
# (the tar also restores .openclaw-config/agents/main/sessions)

systemctl --user start openclaw-gateway.service openclaw-node.service openclaw-watchdog.service

openclaw --version        # expect: OpenClaw 2026.5.26
~/bin/wa-health-watchdog.sh   # expect: UP after reconnect (~90s)
```

## Expected downtime

stop 15s + backup 60s + swap 10s + start 10s + WhatsApp reconnect 30-90s
= 2 to 4 minutes typical, 5 minutes budget. During the window Telegram and
WhatsApp are both down; wa-health-watchdog will not false-alarm if the cutover
starts right after its timer fires (10 min cadence), and the openclaw progress
watchdog is stopped first so it cannot alert either.

## Gotchas (learned during prep, do not skip)

- NEVER run `nvm use --delete-prefix`. nvm complains that `~/.npmrc` has a
  `prefix` (the ~/.npm-global setup) and suggests that flag; it would edit
  `~/.npmrc` and break the global npm prefix. Nothing in this runbook uses
  `nvm use`; all paths to node 24 are absolute.
- Do NOT create `~/.nvm/current`. Both unit PATHs list it (node host lists it
  ahead of /usr/bin); creating it changes node resolution for child processes.
- The old unit Descriptions carried stale versions (2026.3.28 / 2026.2.23 while
  actually running 2026.5.26). The new units say 2026.7.1 and set
  OPENCLAW_SERVICE_VERSION correctly; keep them honest on future upgrades.
- After cutover `~/.npm-global/bin/openclaw` is a wrapper SCRIPT (not a symlink);
  a future `npm i -g` of anything that owns that bin name would clobber it.
- The gateway unit embeds API keys as Environment= lines; the staged copies in
  `~/openclaw-2026.7.1/cutover/` are mode 600 for that reason. Do not commit them.
- Node 24.18.0 lives only in `~/.nvm/versions/node/v24.18.0`. A blanket
  `~/.nvm` cleanup would take the gateway down; leave it alone.
- `minimumReleaseAge: 2880` in 7.1's pnpm-workspace.yaml means any future
  `pnpm install` without the lockfile may resolve differently; always use
  `--frozen-lockfile` in this tree.
