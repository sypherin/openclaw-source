import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { HEARTBEAT_TOKEN } from "../../auto-reply/tokens.js";

/**
 * Remove heartbeat poll/ack pairs from session history to save context tokens.
 *
 * A heartbeat turn is identified by an assistant message whose only text content
 * is "HEARTBEAT_OK" (no tool calls), paired with the immediately preceding user
 * message (the heartbeat poll prompt).
 *
 * This typically saves 200-400 tokens per heartbeat cycle that would otherwise
 * be wasted in every subsequent model call.
 */
export function pruneHeartbeatTurns(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length < 2) {
    return messages;
  }

  const toRemove = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role: string; content?: unknown };
    if (msg.role !== "assistant") {
      continue;
    }

    const content = msg.content;
    if (!content) {
      continue;
    }

    let isHeartbeatOk = false;

    if (typeof content === "string") {
      isHeartbeatOk = content.trim() === HEARTBEAT_TOKEN;
    } else if (Array.isArray(content)) {
      // Skip if there are tool calls — this is a substantive response
      const hasToolCall = content.some(
        (b: { type?: string }) => b.type === "toolCall" || b.type === "tool_use",
      );
      if (hasToolCall) {
        continue;
      }

      const textBlocks = content.filter((b: { type?: string }) => b.type === "text");
      if (textBlocks.length === 0) {
        continue;
      }

      const combinedText = textBlocks
        .map((b: { text?: string }) => b.text ?? "")
        .join("")
        .trim();
      isHeartbeatOk = combinedText === HEARTBEAT_TOKEN;
    }

    if (isHeartbeatOk) {
      toRemove.add(i);
      // Also remove the preceding user message (the heartbeat poll prompt)
      const prev = i > 0 ? (messages[i - 1] as { role: string }) : null;
      if (prev && prev.role === "user") {
        toRemove.add(i - 1);
      }
    }
  }

  if (toRemove.size === 0) {
    return messages;
  }
  return messages.filter((_, idx) => !toRemove.has(idx));
}
