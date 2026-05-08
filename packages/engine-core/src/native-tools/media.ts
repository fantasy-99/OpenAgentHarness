import path from "node:path";

import { formatToolOutput } from "../capabilities/tool-output.js";

export const IMAGE_MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".avif", "image/avif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"]
]);

export function guessImageMimeType(filePath: string): string | undefined {
  return IMAGE_MIME_TYPES_BY_EXTENSION.get(path.extname(filePath).toLowerCase());
}

export function buildImageContextText(input: {
  absolutePath: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  prompt?: string | undefined;
}): string {
  return [
    input.prompt
      ? "The user asked you to inspect this local image with the following prompt."
      : "The user asked you to inspect this local image.",
    "Use the attached image directly when answering. Do not mention base64 or raw binary data.",
    "",
    `image_path: ${input.absolutePath}`,
    `workspace_path: ${input.relativePath}`,
    `media_type: ${input.mediaType}`,
    `size_bytes: ${input.sizeBytes}`,
    ...(input.prompt ? ["", "Prompt:", input.prompt] : [])
  ].join("\n");
}

export function imageContextMessage(input: {
  absolutePath: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  bytes: Buffer;
  prompt?: string | undefined;
}) {
  return {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: buildImageContextText(input)
      },
      {
        type: "image" as const,
        image: input.bytes.toString("base64"),
        mediaType: input.mediaType
      }
    ]
  };
}

export function formatImageDescriptionOutput(input: {
  absolutePath: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  injected: boolean;
  prompt?: string | undefined;
}) {
  return formatToolOutput(
    [
      ["file_path", input.relativePath],
      ["absolute_path", input.absolutePath],
      ["media_type", input.mediaType],
      ["size_bytes", input.sizeBytes],
      ["kind", "image"],
      ["context_injected", input.injected],
      ["prompt", input.prompt]
    ],
    [
      {
        title: "context",
        lines: [
          input.injected
            ? "Image content was injected into the current model context as an internal user message."
            : "Image context injection is unavailable in this runtime."
        ],
        emptyText: "(empty image context)"
      }
    ]
  );
}
