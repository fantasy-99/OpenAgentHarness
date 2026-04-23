import { randomUUID } from "node:crypto";

import { AppError } from "./errors.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }

  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export interface MessagePageCursor {
  createdAt: string;
  id: string;
}

export function encodeMessagePageCursor(cursor: MessagePageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseMessagePageCursor(cursor: string | undefined): MessagePageCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.createdAt !== "string" || parsed.createdAt.length === 0) {
      throw new Error("Missing createdAt.");
    }
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      throw new Error("Missing id.");
    }

    return {
      createdAt: parsed.createdAt,
      id: parsed.id
    };
  } catch {
    throw new AppError(400, "invalid_cursor", "Invalid message cursor.");
  }
}
