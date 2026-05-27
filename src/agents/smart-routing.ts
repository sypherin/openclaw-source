import type { OpenClawConfig } from "../config/types.openclaw.js";
import { log } from "./pi-embedded-runner/logger.js";

/**
 * Smart model routing: content-aware pre-routing that selects the best
 * model for a given request before the sequential fallback chain runs.
 *
 * Config format in openclaw.json:
 *   agents.defaults.model.routing: {
 *     enabled: true,
 *     rules: [
 *       { when: "simple",   prefer: "nvidia-nemotron/nvidia/nemotron-3-nano-30b-a3b" },
 *       { when: "tool_heavy", prefer: "nvidia-glm/z-ai/glm4.7" },
 *       { when: "reasoning",  prefer: "moonshot/kimi-k2.5" }
 *     ]
 *   }
 *
 * Supported "when" classifiers:
 *   - "simple"     → Short conversational messages (greetings, simple Q&A, < 50 words, no code)
 *   - "tool_heavy" → Messages that likely need tool calls (commands, file ops, system tasks)
 *   - "reasoning"  → Complex reasoning, analysis, multi-step planning
 *   - "code"       → Code generation, debugging, programming tasks
 */

export interface RoutingRule {
  when: "simple" | "tool_heavy" | "reasoning" | "code";
  prefer: string; // "provider/model" format
}

export interface SmartRoutingConfig {
  enabled: boolean;
  rules: RoutingRule[];
}

/** Classify a message into a routing category. */
function classifyMessage(message: string): "simple" | "tool_heavy" | "reasoning" | "code" {
  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const lower = trimmed.toLowerCase();

  // Code detection: code blocks, programming keywords, file extensions
  const codePatterns =
    /```|def |function |class |import |const |let |var |return |=>|\.py |\.ts |\.js |\.go |\.rs |compile|debug|refactor|lint|build error|stack trace|traceback|exception/i;
  if (codePatterns.test(trimmed)) {
    return "code";
  }

  // Tool-heavy detection: file operations, system commands, fetch/search, actions
  const toolPatterns =
    /\b(run|execute|install|create|delete|remove|download|upload|fetch|search|find|list|check|scan|open|close|restart|stop|start|send|deploy|update|read|write|edit|move|copy|rename|mkdir|grep|curl|pip|npm|pnpm|apt|brew|git|docker|ssh|scp|wget)\b/i;
  if (toolPatterns.test(lower) && wordCount > 3) {
    return "tool_heavy";
  }

  // Reasoning detection: complex questions, analysis, multi-step, comparisons
  const reasoningPatterns =
    /\b(analyze|compare|explain why|think through|step by step|pros and cons|trade.?offs?|what are the implications|how would you approach|design a|architect|plan|strategy|evaluate|assess|review|summarize|breakdown|deep dive)\b/i;
  if (reasoningPatterns.test(lower)) {
    return "reasoning";
  }

  // Simple: short messages, greetings, yes/no, basic questions
  if (wordCount <= 15) {
    return "simple";
  }

  // Default to tool_heavy for anything else (safest for agent behavior)
  return "tool_heavy";
}

/**
 * Resolve smart routing override for a given message.
 * Returns a preferred model string if a routing rule matches, null otherwise.
 */
export function resolveSmartRouting(params: {
  message: string;
  isHeartbeat: boolean;
  config: OpenClawConfig | undefined;
}): string | null {
  if (params.isHeartbeat) {
    return null; // Don't route heartbeats
  }

  const modelConfig = params.config?.agents?.defaults?.model as
    | { routing?: SmartRoutingConfig }
    | string
    | undefined;

  if (!modelConfig || typeof modelConfig === "string") {
    return null;
  }

  const routing = modelConfig.routing;
  if (!routing?.enabled || !routing.rules?.length) {
    return null;
  }

  const category = classifyMessage(params.message);

  for (const rule of routing.rules) {
    if (rule.when === category && rule.prefer?.trim()) {
      log.debug(`smart-routing: classified as "${category}" → prefer ${rule.prefer}`);
      return rule.prefer;
    }
  }

  return null;
}
