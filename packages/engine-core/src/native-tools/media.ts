import path from "node:path";

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

export function imageToolContent(input: {
  absolutePath: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  bytes: Buffer;
  detail?: "original" | undefined;
}) {
  return {
    type: "content" as const,
    value: [
      {
        type: "text" as const,
        text: [
          `image_path: ${input.absolutePath}`,
          `workspace_path: ${input.relativePath}`,
          `media_type: ${input.mediaType}`,
          `size_bytes: ${input.sizeBytes}`,
          ...(input.detail ? [`detail: ${input.detail}`] : [])
        ].join("\n")
      },
      {
        type: "image-data" as const,
        data: input.bytes.toString("base64"),
        mediaType: input.mediaType,
        ...(input.detail ? { providerOptions: { detail: input.detail } } : {})
      }
    ]
  };
}
