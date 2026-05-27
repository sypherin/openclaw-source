# Local Patches — sypherin/openclaw

This file tracks all custom modifications in this fork that differ from [openclaw/openclaw](https://github.com/openclaw/openclaw) upstream.

## Active Local Patches

These patches must be preserved during upstream merges.

### 1. NVIDIA NIM Model Support

Added compatibility for NVIDIA NIM models that upstream doesn't natively support:

- **Qwen3.5-397B-A17B** — primary model via NVIDIA NIM with content-aware routing (tool_heavy/reasoning/code tasks)
- **GLM-5 / GLM-4.7** (THUDM) — empty tool call filter strips garbage `tool_calls` arrays; assistant content forced to plain string to prevent JSON mimicking; now used as fallback for simple tasks
- **Kimi K2.5** (Moonshot) — reasoning-to-text fallback promotes thinking blocks when no text content is returned
- **DeepSeek V3.2** — added to model registry via NVIDIA NIM
- **QwQ-32B**, **Qwen3-Coder-Next** — local model support via llama.cpp and Lemonade

Key changes:

- `feat: add pi-ai post-install patch script for NVIDIA model compat` — patches `@mariozechner/pi-ai` openai-completions.js across all installed versions with 8 fixes (plain string content, empty tool call filter, reasoning fallback, 120s per-request timeout, Kimi K2.5 tool call ID normalization, text-to-tool-call fallback parser, strip `reasoning_content` from history, global API key fallback for custom providers). Run `scripts/apply-pi-ai-patches.sh` after `pnpm install`.
- **Global API key fallback** — pi-ai's `streamSimpleOpenAICompletions` now checks `globalThis.__openclawResolvedApiKeys` as a last-resort fallback when `options.apiKey` is not injected and `getEnvApiKey()` has no mapping for custom providers (nvidia-qwen, nvidia-glm, etc.). Companion patch in pi-coding-agent's `AuthStorage.setRuntimeApiKey()` populates the global eagerly.
- **GLM `<tool_call>` XML handling** — GLM4.7/GLM5 sometimes emit tool invocations as `<tool_call>` XML tags in text instead of using proper function calling. pi-ai patch 6 now parses both JSON and XML tool call formats (`<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`) and converts them to structured tool calls. `normalize-reply.ts` strips any remaining XML fragments before channel delivery. **Also wired into `src/agents/pi-embedded-runner/run/attempt.ts`** via `wrapStreamFnParseGlmToolCalls` (from `./glm-tool-call-repair.js`) positioned before `wrapStreamFnSanitizeMalformedToolCalls` in the wrapper chain — covers the case pi-ai patch 6 misses, where a native tool call arrives alongside a duplicate XML tool call in text (patch 6 only fires when there are zero native tool calls). Helper previously existed as dead code; restored 2026-04-11.
- **zai excluded from GLM XML repair** — `shouldParseGlmToolCalls()` short-circuits for `provider === "zai"` because z.ai uses the Anthropic API format and returns proper `tool_use` blocks; running the GLM XML wrapper on top double-parses and breaks responses. Applied as a `dist/` patch (compiled line-edit); re-apply after any `pnpm build`.
- **z.ai GLM-5.1 via Anthropic endpoint** — provider `zai` registered with `api: "anthropic-messages"` pointing at `https://api.z.ai/api/anthropic`. The z.ai coding subscription plan does **not** route through the OpenAI-compatible `paas/v4` endpoint — a coding-plan key on `paas/v4` returns `"Insufficient balance"` even when the plan is active. The Anthropic endpoint works. Wired as primary in the model chain, with nvidia-glm / nvidia-step / nvidia-glm5 / local-llama as fallbacks. Session-level `modelOverride`/`providerOverride` get persisted on fallback and pin the session to the fallback forever — clear those fields manually in `agents/main/sessions/sessions.json` (filter by specific unwanted provider/model only; preserve deliberate per-cron overrides).
- `fix: hook loading + remove custom NVIDIA stream routing` — removed custom `nvidia-reasoning-stream` StreamFn routing so all non-Ollama models use standard `streamSimple`, which properly forwards `tools`/`tool_choice` params to the API.
- **Qwen3 `/no_think` directive** — auto-injects `/no_think` into system prompt when model name contains "qwen", reducing false safety refusals and improving tool call reliability.

### 2. Security Hardening

- **Prompt injection guardrails** — detection layer wired into the agent flow to catch injection attempts in inbound messages
- **RateLimiter memory leak fix** — patched leak in the rate limiter and replaced empty `catch` blocks with proper logging
- **Security tests** — added test coverage for security-critical paths
- **Malicious hook removal** — removed `soul-evil` hook and blocked it from the fork
- **Non-admin status redaction** — sensitive status details are now redacted for non-admin scopes
- **SSRF IPv6 transition bypass block** — prevents SSRF via IPv6 transition address bypasses (upstream)
- **Path traversal prevention (OC-06)** — confines config `$include` resolution to top-level config directory (upstream)
- **Sandbox env sanitization** — sanitizes environment variables before Docker launch (upstream)
- **SafeBins path trust hardening** — extracted trust resolver with stricter path validation (upstream)
- **Cron webhook SSRF guard** — guards cron webhook delivery against SSRF (upstream)
- **Telegram command sanitization** — sanitizes native command names for Telegram API (upstream)
- **ReDoS prevention** — rewrote external-content suspicious pattern regexes with bounded quantifiers and added input length cap to prevent catastrophic backtracking
- **FTS5 injection hardening** — strips FTS reserved tokens (`AND`, `OR`, `NOT`, `NEAR`) and caps token count in hybrid memory search queries
- **Browser eval sandbox hardening** — blocks indirect API access patterns (`window["..."]`, `Reflect.get`, `new Proxy`, dynamic `import()`) in the eval security validator
- **Cross-protocol WebSocket hijacking (CSWSH) protection** — origin check now validates protocol compatibility (HTTPS↔WSS, HTTP↔WS) with loopback exemption for local dev
- **Canvas capability TTL reduction** — reduced from 10 min to 5 min to shrink the window for token reuse
- **Error path credential redaction** — wrapped error serialization in gateway, hooks loader, and plugins loader through `redactSensitiveText()` to prevent leaking secrets in logs
- **Dangerous config startup warnings** — gateway now logs security warnings at startup when `dangerouslyDisableDeviceAuth`, `allowInsecureAuth`, or empty `trusted-proxy.allowUsers` are detected
- **Browser eval deep hardening** — blocked `eval()`, `Function()` constructor, `String.fromCharCode` API name reconstruction, prototype chain abuse (`constructor.constructor`), `setTimeout`/`setInterval` with string/Function args, `document.domain` assignment, `window.location` writes, `Object.getOwnPropertyNames(window)` introspection, and `localStorage`/`sessionStorage` read access (token exfiltration prevention)
- **Explicit gateway method scopes** — replaced prefix-based admin scope matching with explicit method-to-scope entries; prefix fallback now emits runtime warnings for unclassified methods
- **Plugin install code scan enforcement** — critical code pattern findings now block plugin installation (was warn-only); `--force` flag available for explicit override
- **Slack menu token entropy** — replaced `Math.random()` with `crypto.randomBytes(8)` for external arg menu tokens
- **Cron tool invoke denial** — cron tool denied on `/tools/invoke` by default to prevent unauthenticated cron scheduling
- **Trusted-proxy auth fix** — includes `trusted-proxy` in `sharedAuthOk` check for consistent auth gating

### 3. Hook System Fixes

- **`__exportAll` circular dependency fix** (`fix-hook-circular-deps.sh`) — post-build patch that handles multiple `pi-embedded` chunks and dynamic export aliases across all subdirectories (`dist/`, `plugin-sdk/`, `bundled/`). Fixes `boot-md` and `session-memory` hooks failing with `"__exportAll is not a function"`. Related upstream issue: [#13662](https://github.com/openclaw/openclaw/issues/13662)
- **Plugin SDK alias fix** — prefers source `plugin-sdk` alias to avoid `jiti` circular import crash

### 4. Stability & Bug Fixes

- **LLM rate limit circuit breaker** — replaced retry loop with circuit breaker pattern + failover notifications
- **`<think>` tag leakage** — prevented thinking block content from leaking into streamed output
- **Thinking text leak filter** (`normalize-reply.ts`) — strips leaked chain-of-thought from outbound messages before channel delivery
- **Browser tab-not-found error fix** (`client-fetch.ts`, `browser-tool.ts`) — actionable recovery instructions when browser tab reference becomes stale
- **Browser argument sanitization** (`browser-tool.ts`) — detects and recovers from XML-in-JSON argument corruption from weaker models
- **Slug generator model fix** — reads primary model from config instead of hardcoded Anthropic model
- **Discord reasoning tag strip** — strips `<reasoning>`/`<thinking>` tags from partial stream previews
- **Matrix reasoning-only filter** — skips reasoning-only messages in Matrix delivery
- **Reasoning payload suppression** — suppresses reasoning payloads from generic channel dispatch
- **fixFlattenedMarkdown** — restores structure in wall-of-text replies from Qwen/NVIDIA models
- **OpenRouter 'auto' model fix** — skips reasoning effort injection for OpenRouter's `auto` routing model
- **Orphaned tool result repair** — repairs orphaned tool results for OpenAI after history truncation
- **isReasoningTagProvider** — adds NVIDIA providers (nvidia-step, nvidia-kimi-k2, minimax) and `local-llama` for `<think>` tag stripping
- **Empty-payload delivery acknowledgment** — when a model completes tool actions (e.g. `cron_update`) but emits no text reply, upstream logs `"No reply from agent"` and silently drops. Patched `src/agents/pi-embedded-runner/run.ts:1330` (empty payloads `undefined` → `[]` for consistent downstream typing) and `src/agents/command/delivery.ts:269` (when payloads are empty but `didSendViaMessagingTool` or `successfulCronAdds > 0`, send a `"✓ Done."` ack to the originating channel). Prevents silent drops on GPT-5.4-rate-limit → nvidia-glm failover.
- **WhatsApp media reply normalization** — upstream `normalizeReplyPayloadMedia()` in `src/auto-reply/reply/agent-runner-payloads.ts` had a catch block that zeroed `mediaUrl`/`mediaUrls`/`audioAsVoice` when local path resolution threw, silently dropping valid remote URLs. Fix returns `params.payload` unchanged on error. Submitted upstream as **PR #64449** (branch `fix/media-reply-normalization-fallback` on remote `sypherin/openclaw-1`).
- **`[cron:` → `[cron ` cron prefix** — z.ai glm-5.1's ingress filter bans the literal `[cron:` at the start of a user message (classes it as a prompt-injection marker) and returns HTTP 429. Changed prefix to `[cron ${id} ${name}]` in `src/cron/isolated-agent/run.ts:368`, plus the two affected tests (`src/gateway/server-methods/server-methods.test.ts:182`, `src/cron/isolated-agent.session-identity.test.ts:49`). Only glm-5.1 on the anthropic endpoint triggers — glm-4.6 passes `[cron:` fine — but `[cron ` is strictly more portable across providers. Worth upstreaming.

### 5. Smart Model Routing & Context Optimization

- **Content-aware model routing** (`smart-routing.ts`) — classifies inbound messages as `simple`, `tool_heavy`, `reasoning`, or `code` and pre-routes to the best model
- **Heartbeat transcript pruning** (`heartbeat-pruning.ts`) — strips `HEARTBEAT_OK` poll/ack pairs from session history
- **Per-tool softTrim context pruning** — tool-specific `maxChars`/`headChars`/`tailChars` overrides
- **Instructor pattern for tool errors** — enriches tool call error results with `expected_params`, `required_params`, and `retry_hint`

### 6. Native Tool Additions

- **FLUX.1-dev image generation** — native `image_gen` tool via NVIDIA NIM
- **Gemini TTS provider** — configured via upstream's new `providers` map (migrated from per-provider fields to `tts.providers.gemini` in openclaw.json)

### 7. Additional Features

- **Himalaya email skill** — OAuth2 email integration via himalaya with draft save support
- **Instagram posting skill** — `late-api` skill for automated Instagram posting
- **Configurable heartbeat session** — customizable heartbeat interval
- **Discord `allowBots` config** — option to allow bot messages in Discord channels
- **Auto-reply multilingual stop triggers** — normalized stop matching with multilingual trigger support

### 8. QMD Memory System

- **mcporter spawn retry** — Windows EINVAL spawn fallback for mcporter daemon (inlined in `qmd-manager.ts`)

## Upstream Cherry-Picks (now merged)

These were cherry-picked from upstream branches before they landed in main. Now part of upstream main after merge.

- **Sonnet 4.6 support** — `anthropic/claude-sonnet-4-6` with forward-compat fallback
- **1M context beta header** — opt-in via model `params.context1m: true`
- **24 subagent reliability fixes** — completion delivery, sticky reply threading, read-tool overflow guards
- **Configurable default `runTimeoutSeconds`** — subagent spawns now respect config
- **"Use when / Don't use when" routing blocks** — conditional skill activation boundaries

## Merge History

| Date       | Upstream Commits | Key Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-27 | ~21745           | Major upstream rebase onto `fresh-upstream`. pi-ai package renamed `@mariozechner` → `@earendil-works`. GLM XML helpers inlined into `glm-tool-call-repair.ts`. `isReasoningTagProvider` now plugin-based; NVIDIA providers added to `BUILTIN_REASONING_OUTPUT_MODES`. `delivery.ts` heavily refactored; empty-payload ack adapted to new `sendDurableMessageBatch` API. Many security patches now upstream. `normalize-reply.ts` uses new `copyReplyPayloadMetadata` + `sanitizeUserFacingText` pipeline; `stripThinkingTextLeaks` + `fixFlattenedMarkdown` re-added after upstream sanitizer. |
| 2026-04-11 | —                | z.ai GLM-5.1 Anthropic-endpoint wire-up, GLM XML repair restored in `attempt.ts`, zai excluded from repair wrapper, `[cron ` prefix change, WhatsApp media reply PR submitted upstream (#64449)                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-03-29 | 50               | Telegram fixes, plugin runtime refactor, memory/LanceDB fix, gateway auth, subagent fixes, exec sandbox hardening, Matrix streaming, TUI fixes                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-03-27 | 411              | Provider runtime → extensions, 503 model fallback, TTS provider registry refactor, video gen infra, skill source rename, zod validation                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-03-11 | 908              | Strip leaked control tokens, telegram chunking, cron stagger on restart, bootstrap file protection, duplicate cooldown probe fix, Alibaba Bailian onboarding                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-02-24 | 845              | Auto-reply multilingual stop, allowFrom breaking change, reasoning payload suppression, configurable subagent timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-02-22 | 320              | routingPrefer, redactSensitiveText preserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Notes on 2026-05-27 Rebase

### Now Upstream (no longer local patches)

- Most security hardening patches (SSRF, path traversal, sandbox env, ReDoS, FTS5, etc.)
- OpenRouter 'auto' model fix
- Orphaned tool result repair
- Discord/Matrix reasoning tag handling (via `reasoning-tags.ts` + `assistant-visible-text.ts`)
- `stripModelSpecialTokens` (moved to `shared/text/model-special-tokens.ts`)
- `stripMinimaxToolCallXml` (moved to `shared/text/assistant-visible-text.ts`)
- Reasoning payload suppression
- Browser tab-not-found error fix
- Slug generator model fix
- Auto-reply multilingual stop triggers

### Package Renames

- `@mariozechner/pi-ai` → `@earendil-works/pi-ai`
- `@mariozechner/pi-agent-core` → `@earendil-works/pi-agent-core`

### Architecture Changes

- `isReasoningTagProvider` now plugin-based via `resolveProviderReasoningOutputModeWithPlugin()`. NVIDIA providers added to `BUILTIN_REASONING_OUTPUT_MODES` as fallback.
- `delivery.ts` refactored to use `sendDurableMessageBatch` + typed `AgentCommandDeliveryResult` instead of direct `deliverOutboundPayloads`.
- `normalize-reply.ts` now uses `copyReplyPayloadMetadata` for payload construction.
- GLM XML helpers (`parseGlmToolCallXml`, `stripGlmToolCallXml`) removed from `pi-embedded-utils.ts`; inlined into `glm-tool-call-repair.ts`.
- `sanitizeUserFacingText` moved to `agents/pi-embedded-helpers/sanitize-user-facing-text.ts`.

## How to Merge Upstream

```bash
git fetch upstream
git merge upstream/main
# Resolve conflicts — preserve patches listed above
pnpm install && pnpm build
./scripts/apply-pi-ai-patches.sh  # re-apply NVIDIA patches
# Restart gateway
systemctl --user restart openclaw-gateway
```
