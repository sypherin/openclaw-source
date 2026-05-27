// Normalizes raw agent output into sendable reply text and metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import {
  HEARTBEAT_TOKEN,
  isInternalFormattingArtifact,
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveResponsePrefixTemplate,
  type ResponsePrefixContext,
} from "./response-prefix-template.js";

/**
 * Strips leaked chain-of-thought / reasoning text that some models (e.g. GLM 4.7)
 * accidentally include in the assistant text instead of keeping it in a separate
 * `thinking` content block.
 *
 * Handles:
 *  - XML-wrapped blocks: <think>...</think>, <thinking>...</thinking>, <reasoning>...</reasoning>
 *  - Inline thinking prefixes like "Let me think about this..." that precede the real answer.
 *
 * LOCAL PATCH — sypherin/openclaw fork only.
 */
const THINKING_BLOCK_RE =
  /<(?:think|thinking|reasoning|internal_thoughts|chain_of_thought|reflection)>[\s\S]*?<\/(?:think|thinking|reasoning|internal_thoughts|chain_of_thought|reflection)>/gi;

const THINKING_PREFIX_RE =
  /^(?:(?:okay|ok|alright|right|so|well|hmm|let me)[,.]?\s+)*(?:(?:so\s+)?(?:the\s+)?user\s+(?:is asking|wants|asked|said|has asked|is requesting|seems to|appears to|needs|would like)\b.*?\n+)+/i;

const LET_ME_THINK_RE =
  /^(?:(?:okay|ok|alright|sure|right)[,.]?\s+)?let me\s+(?:think|analyze|consider|figure|work|break|look|check|plan|reason)\b[^]*?\n\n/i;

const TOOL_CALL_LEAK_RE =
  /<(?:arg_key|arg_value|tool_call|function_call|tool_use|parameters|arguments)>[\s\S]*?<\/(?:arg_key|arg_value|tool_call|function_call|tool_use|parameters|arguments)>/gi;

const ORPHAN_TOOL_TAG_RE =
  /<\/?(?:arg_key|arg_value|tool_call|function_call|tool_use|parameters|arguments)>/gi;

export function stripThinkingTextLeaks(text: string): string {
  if (!text) {
    return text;
  }
  let cleaned = text.replace(THINKING_BLOCK_RE, "").trim();
  cleaned = cleaned.replace(TOOL_CALL_LEAK_RE, "").trim();
  cleaned = cleaned.replace(ORPHAN_TOOL_TAG_RE, "").trim();
  cleaned = cleaned.replace(THINKING_PREFIX_RE, "").trim();
  cleaned = cleaned.replace(LET_ME_THINK_RE, "").trim();
  return cleaned || text;
}

/**
 * Fixes "flattened" markdown where the model outputs bold headings, bullet
 * points, and numbered lists on a single line with no line breaks.
 *
 * LOCAL PATCH — sypherin/openclaw fork only.
 */
export function fixFlattenedMarkdown(text: string): string {
  if (!text || text.length < 60) {
    return text;
  }
  const existingNewlines = (text.match(/\n/g) || []).length;
  const boldHeaders = (text.match(/(?:^| )\*\*[^*]+(?::\*\*|\*\*:)/gm) || []).length;
  const dashBullets = (text.match(/(?:^| )- (?:\*\*|[A-Z0-9])/gm) || []).length;
  const asteriskBullets = (text.match(/(?:^| )\* (?:\*\*|[A-Z])/gm) || []).length;
  const numberedItems = (text.match(/(?:^| )\d+\. /gm) || []).length;
  const emojiHeaders = (
    text.match(/(?:^| )[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+\s*\*\*/gmu) || []
  ).length;
  const structureCount = boldHeaders + dashBullets + asteriskBullets + numberedItems + emojiHeaders;

  if (structureCount >= 2 && existingNewlines <= structureCount * 0.5) {
    let fixed = text;
    fixed = fixed.replace(/ (- \*\*)/g, "\n$1");
    fixed = fixed.replace(/ (\* \*\*)/g, "\n$1");
    fixed = fixed.replace(/ (- [A-Z0-9])/g, "\n$1");
    fixed = fixed.replace(/ (\* [A-Z])/g, "\n$1");
    fixed = fixed.replace(/ (\d+\.\s)/g, "\n$1");
    fixed = fixed.replace(/([.!?)"]) (\*\*[^*]{2,}\*\*)/g, (_match, punct, header, offset) => {
      const before = fixed.slice(Math.max(0, offset - 2), offset);
      if (/\d$/.test(before)) {
        return punct + " " + header;
      }
      return punct + "\n\n" + header;
    });
    fixed = fixed.replace(/ ([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+\s*\*\*)/gu, "\n\n$1");
    fixed = fixed.replace(/ (#{1,6} )/g, "\n\n$1");
    fixed = fixed.replace(/(\*\*)\n(\d+\.)/g, "$1\n\n$2");
    fixed = fixed.replace(/\n{3,}/g, "\n\n");
    return fixed.trim();
  }

  if (existingNewlines === 0 && text.length > 250) {
    const sentences = text.split(/(?<=\.) (?=[A-Z])/);
    if (sentences.length >= 4) {
      const paragraphs: string[] = [];
      let current: string[] = [];
      for (const sentence of sentences) {
        current.push(sentence);
        if (current.join(" ").length > 150) {
          paragraphs.push(current.join(" "));
          current = [];
        }
      }
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
      }
      if (paragraphs.length >= 2) {
        return paragraphs.join("\n\n");
      }
    }
  }

  return text;
}

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

type NormalizeReplyOptions = {
  responsePrefix?: string;
  applyChannelTransforms?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const applyChannelTransforms = opts.applyChannelTransforms ?? true;
  const hasContent = (text: string | undefined) =>
    hasReplyPayloadContent(
      {
        ...payload,
        text,
      },
      {
        trimText: true,
      },
    );
  const trimmed = normalizeOptionalString(payload.text) ?? "";
  if (!hasContent(trimmed)) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyPayloadText(text, silentToken)) {
    if (!hasContent("")) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }
  // Strip NO_REPLY from mixed-content messages (e.g. "😄 NO_REPLY") so the
  // token never leaks to end users.  If stripping leaves nothing, treat it as
  // silent just like the exact-match path above.  (#30916, #30955)
  if (text && !isSilentReplyText(text, silentToken)) {
    const hasLeadingSilentToken = startsWithSilentToken(text, silentToken);
    if (hasLeadingSilentToken) {
      text = stripLeadingSilentToken(text, silentToken);
    }
    if (hasLeadingSilentToken || text.toLowerCase().includes(silentToken.toLowerCase())) {
      text = stripSilentToken(text, silentToken);
      if (!hasContent(text)) {
        opts.onSkip?.("silent");
        return null;
      }
    }
  }
  if (text && !trimmed) {
    // Keep empty text when media exists so media-only replies still send.
    text = "";
  }

  const shouldStripHeartbeat = opts.stripHeartbeat ?? true;
  if (shouldStripHeartbeat && text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.didStrip) {
      opts.onHeartbeatStrip?.();
    }
    if (stripped.shouldSkip && !hasContent(stripped.text)) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text && isInternalFormattingArtifact(text) && !hasContent("")) {
    opts.onSkip?.("silent");
    return null;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
    // LOCAL PATCH: strip leaked thinking/reasoning text and fix flattened markdown
    text = stripThinkingTextLeaks(text);
    text = fixFlattenedMarkdown(text);
  }
  if (!hasContent(text)) {
    opts.onSkip?.("empty");
    return null;
  }

  let enrichedPayload: ReplyPayload = copyReplyPayloadMetadata(payload, { ...payload, text });
  if (applyChannelTransforms && opts.transformReplyPayload) {
    const transformedPayload = opts.transformReplyPayload(enrichedPayload);
    if (transformedPayload === null) {
      return null;
    }
    enrichedPayload = transformedPayload
      ? copyReplyPayloadMetadata(enrichedPayload, transformedPayload)
      : enrichedPayload;
    text = enrichedPayload.text;
  }

  // Resolve template variables in responsePrefix if context is provided
  const effectivePrefix = opts.responsePrefixContext
    ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext)
    : opts.responsePrefix;

  if (
    effectivePrefix &&
    text &&
    text.trim() !== HEARTBEAT_TOKEN &&
    !text.startsWith(effectivePrefix)
  ) {
    text = `${effectivePrefix} ${text}`;
  }

  enrichedPayload = copyReplyPayloadMetadata(enrichedPayload, { ...enrichedPayload, text });
  return enrichedPayload;
}
