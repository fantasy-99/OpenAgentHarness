import path from "node:path";

import { formatToolOutput } from "../capabilities/tool-output.js";
import type { NativeToolSetOptions } from "./types.js";

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

export async function describeImageWithModel(
  options: NativeToolSetOptions | undefined,
  input: {
    absolutePath: string;
    relativePath: string;
    mediaType: string;
    sizeBytes: number;
    bytes: Buffer;
    prompt?: string | undefined;
  },
  signal?: AbortSignal | undefined
): Promise<string> {
  if (!options?.modelGateway || !options.imageDescriptionModel) {
    return [
      "Image description unavailable: no model gateway or image description model is configured for this runtime.",
      "Configure imageDescriptionModel to let Read and ViewImage return model-generated image descriptions."
    ].join("\n");
  }

  const response = await options.modelGateway.generate(
    {
      model: options.imageDescriptionModel,
      maxTokens: 900,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                input.prompt
                  ? "Analyze this local image for a coding agent that cannot see it directly, focusing on the user's prompt."
                  : "Describe this local image for a coding agent that cannot see it directly.",
                input.prompt
                  ? "Answer the prompt directly, and include visible evidence from the image when useful."
                  : "Include any visible text, UI layout, diagrams, objects, colors, and details that could affect implementation or debugging.",
                "Be concise but specific. Do not include base64 or raw binary data.",
                "",
                `image_path: ${input.absolutePath}`,
                `workspace_path: ${input.relativePath}`,
                `media_type: ${input.mediaType}`,
                `size_bytes: ${input.sizeBytes}`,
                ...(input.prompt ? ["", "User prompt:", input.prompt] : [])
              ].join("\n")
            },
            {
              type: "image",
              image: input.bytes.toString("base64"),
              mediaType: input.mediaType
            }
          ]
        }
      ]
    },
    signal ? { signal } : undefined
  );

  return response.text.trim() || "(empty image description)";
}

export function formatImageDescriptionOutput(input: {
  absolutePath: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  description: string;
  prompt?: string | undefined;
}) {
  return formatToolOutput(
    [
      ["file_path", input.relativePath],
      ["absolute_path", input.absolutePath],
      ["media_type", input.mediaType],
      ["size_bytes", input.sizeBytes],
      ["kind", "image"],
      ["prompt", input.prompt]
    ],
    [
      {
        title: "description",
        lines: input.description.length > 0 ? input.description.split(/\r?\n/) : [],
        emptyText: "(empty image description)"
      }
    ]
  );
}
