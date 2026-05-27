/**
 * Provider behavior helpers shared by reply runners, embedded agents, and provider plugins.
 * Keep policy here generic; provider-specific reasoning rules belong in provider runtime hooks.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveProviderReasoningOutputModeWithPlugin } from "../plugins/provider-runtime.js";
// LOCAL PATCH: these providers emit reasoning in <think> tags and must be
// force-tagged. Upstream's minimax extension declares "native", which leaks the
// raw tags into replies; this const is consulted BEFORE the provider plugin hook
// (see resolveReasoningOutputMode) so it overrides that. normalizeOptionalString
// is already imported above from the relocated normalization package.
const BUILTIN_REASONING_OUTPUT_MODES = {
  "google-generative-ai": "tagged",
  "nvidia-step": "tagged",
  "nvidia-kimi-k2": "tagged",
  minimax: "tagged",
  "local-llama": "tagged",
} as const;

/**
 * Resolves whether a provider should emit reasoning via native fields or tagged text,
 * using provider runtime hooks when available and defaulting to native output.
 */
function resolveReasoningOutputMode(params: {
  provider: string | undefined | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  runtimeHandle?: ProviderRuntimePluginHandle;
}): "native" | "tagged" {
  const provider = normalizeOptionalString(params.provider);
  if (!provider) {
    return "native";
  }

  // LOCAL PATCH: hardcoded overrides win over provider hooks for the NIM/local
  // providers that emit <think> tags (upstream declares some of these "native",
  // which would leak the tags). Checked before the plugin hook on purpose.
  const builtinMode = BUILTIN_REASONING_OUTPUT_MODES[provider as keyof typeof BUILTIN_REASONING_OUTPUT_MODES];
  if (builtinMode) {
    return builtinMode;
  }

  // Provider hooks own model/API-specific reasoning transport rules; core only supplies the default.
  const pluginMode = resolveProviderReasoningOutputModeWithPlugin({
    provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtimeHandle: params.runtimeHandle,
    context: {
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      provider,
      modelId: params.modelId,
      modelApi: params.modelApi,
      model: params.model,
    },
  });
  if (pluginMode) {
    return pluginMode;
  }

  return "native";
}

/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export function isReasoningTagProvider(
  provider: string | undefined | null,
  options?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    modelId?: string;
    modelApi?: string | null;
    model?: ProviderRuntimeModel;
    runtimeHandle?: ProviderRuntimePluginHandle;
  },
): boolean {
  return (
    resolveReasoningOutputMode({
      provider,
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      env: options?.env,
      modelId: options?.modelId,
      modelApi: options?.modelApi,
      model: options?.model,
      runtimeHandle: options?.runtimeHandle,
    }) === "tagged"
  );
}
