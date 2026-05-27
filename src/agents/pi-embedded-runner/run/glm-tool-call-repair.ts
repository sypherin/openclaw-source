/**
 * GLM Tool Call Repair — Stream wrapper that converts GLM-style XML tool calls
 * from text content into proper structured tool call blocks.
 *
 * GLM 4.7 and GLM 5 sometimes emit tool calls as XML in text instead of
 * structured function_call/tool_calls in the API response:
 *
 *   <tool_call>image_gen<arg_key>prompt</arg_key><arg_value>a photo</arg_value></tool_call>
 *
 * This wrapper intercepts the stream and converts those into proper tool call
 * content blocks so they get executed by the agent loop.
 *
 * LOCAL PATCH — sypherin/openclaw fork only.
 * The GLM XML helpers (parseGlmToolCallXml, stripGlmToolCallXml) were removed
 * from upstream pi-embedded-utils.ts; they are inlined here.
 */

import { randomBytes } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Inlined GLM XML helpers (removed from upstream pi-embedded-utils.ts)
// ---------------------------------------------------------------------------

interface ParsedGlmToolCall {
  name: string;
  arguments: Record<string, string>;
}

const GLM_TOOL_CALL_RE = /<tool_call>[\s\S]*?<\/tool_call>/gi;
const GLM_ORPHAN_TOOL_TAGS_RE = /<\/?(?:tool_call|arg_key|arg_value|function_call)>/gi;

function stripGlmToolCallXml(text: string): string {
  if (!text) {
    return text;
  }
  if (!/<tool_call/i.test(text) && !/<arg_key/i.test(text)) {
    return text;
  }
  let cleaned = text.replace(GLM_TOOL_CALL_RE, "");
  cleaned = cleaned.replace(GLM_ORPHAN_TOOL_TAGS_RE, "");
  return cleaned.trim();
}

function parseGlmToolCallXml(text: string): ParsedGlmToolCall[] {
  if (!text || !/<tool_call/i.test(text)) {
    return [];
  }
  const results: ParsedGlmToolCall[] = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(text)) !== null) {
    const inner = blockMatch[1];
    // Extract tool name (text before first <arg_key>)
    const nameMatch = inner?.match(/^([^<\s]+)/);
    if (!nameMatch) {
      continue;
    }
    const name = nameMatch[1]?.trim();
    if (!name) {
      continue;
    }
    // Extract key-value pairs
    const args: Record<string, string> = {};
    const pairRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
    let pairMatch;
    while ((pairMatch = pairRe.exec(inner ?? "")) !== null) {
      const key = pairMatch[1]?.trim();
      const value = pairMatch[2]?.trim();
      if (key) {
        args[key] = value ?? "";
      }
    }
    results.push({ name, arguments: args });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

function promoteGlmToolCallsInMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }

  let promoted = false;
  const newContent: unknown[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") {
      newContent.push(block);
      continue;
    }
    const typed = block as { type?: string; text?: string };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      newContent.push(block);
      continue;
    }

    const parsed = parseGlmToolCallXml(typed.text);
    if (parsed.length === 0) {
      newContent.push(block);
      continue;
    }

    // Strip the XML from the text and keep any remaining text
    const remainingText = stripGlmToolCallXml(typed.text).trim();
    if (remainingText) {
      newContent.push({ type: "text", text: remainingText });
    }

    // Add structured tool call blocks for each parsed call
    for (const call of parsed) {
      const toolCallId = `glm_${randomBytes(6).toString("hex")}`;
      newContent.push({
        type: "toolCall",
        toolCallId,
        name: call.name,
        arguments: call.arguments,
      });
    }
    promoted = true;
  }

  if (promoted) {
    (message as { content: unknown[] }).content = newContent;
  }
  return promoted;
}

function wrapStreamParseGlmToolCalls(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    promoteGlmToolCallsInMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { message?: unknown };
            // Only modify completed messages, not partials (avoid mangling streaming)
            if (event.message) {
              promoteGlmToolCallsInMessage(event.message);
            }
          }
          return result;
        },
        async return(value?: unknown) {
          return (
            iterator.return?.(value) ?? {
              done: true as const,
              value: undefined,
            }
          );
        },
        async throw(error?: unknown) {
          return (
            iterator.throw?.(error) ?? {
              done: true as const,
              value: undefined,
            }
          );
        },
      };
    };
  return stream;
}

export function wrapStreamFnParseGlmToolCalls(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) => wrapStreamParseGlmToolCalls(stream));
    }
    return wrapStreamParseGlmToolCalls(maybeStream);
  };
}

/** Check if the current provider is a GLM model that may emit text-based tool calls. */
export function shouldParseGlmToolCalls(provider?: string, modelId?: string): boolean {
  if (!provider && !modelId) {
    return false;
  }
  const p = (provider ?? "").toLowerCase();
  const m = (modelId ?? "").toLowerCase();
  // z.ai uses the Anthropic API format and returns proper tool_use blocks;
  // running the GLM XML wrapper on top double-parses and breaks responses.
  if (p === "zai" || p === "z-ai" || p === "z.ai") {
    return false;
  }
  return p.includes("glm") || m.includes("glm") || m.includes("z-ai/glm");
}
