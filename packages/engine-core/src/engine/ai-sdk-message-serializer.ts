import type { ChatMessage } from "@oah/api-contracts";

import { contentToPromptMessage, extractTextFromContent } from "../execution-message-content.js";
import type { ModelMessage } from "./message-projections.js";

export class ModelMessageSerializer {
  toAiSdkMessages(messages: ModelMessage[]): ChatMessage[] {
    return messages.map((message) => {
      if (message.role === "system" && typeof message.content !== "string") {
        return {
          role: "system",
          content: extractTextFromContent(message.content)
        };
      }

      return contentToPromptMessage(message.role, message.content);
    });
  }
}
