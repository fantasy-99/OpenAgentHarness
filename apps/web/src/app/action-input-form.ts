function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type StructuredActionInputField =
  | {
      kind: "string";
      name: string;
      label: string;
      description?: string;
      required: boolean;
      defaultValue?: string;
    }
  | {
      kind: "string_enum";
      name: string;
      label: string;
      description?: string;
      required: boolean;
      options: string[];
      defaultValue?: string;
    }
  | {
      kind: "number" | "integer";
      name: string;
      label: string;
      description?: string;
      required: boolean;
      defaultValue?: number;
    }
  | {
      kind: "boolean";
      name: string;
      label: string;
      description?: string;
      required: boolean;
      defaultValue?: boolean;
    };

export interface StructuredActionInputSpec {
  fields: StructuredActionInputField[];
}

export type StructuredActionInputValues = Record<string, string>;

function humanizeFieldName(name: string): string {
  return name
    .split(/[_\-.]/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function readStructuredField(
  name: string,
  schema: Record<string, unknown>,
  required: boolean
): StructuredActionInputField | null {
  const label = typeof schema.title === "string" && schema.title.trim().length > 0 ? schema.title.trim() : humanizeFieldName(name);
  const description = typeof schema.description === "string" && schema.description.trim().length > 0 ? schema.description.trim() : undefined;

  if (Array.isArray(schema.enum) && schema.enum.every((entry) => typeof entry === "string")) {
    return {
      kind: "string_enum",
      name,
      label,
      ...(description ? { description } : {}),
      required,
      options: schema.enum,
      ...(typeof schema.default === "string" ? { defaultValue: schema.default } : {})
    };
  }

  switch (schema.type) {
    case "string":
      return {
        kind: "string",
        name,
        label,
        ...(description ? { description } : {}),
        required,
        ...(typeof schema.default === "string" ? { defaultValue: schema.default } : {})
      };
    case "number":
      return {
        kind: "number",
        name,
        label,
        ...(description ? { description } : {}),
        required,
        ...(typeof schema.default === "number" ? { defaultValue: schema.default } : {})
      };
    case "integer":
      return {
        kind: "integer",
        name,
        label,
        ...(description ? { description } : {}),
        required,
        ...(typeof schema.default === "number" ? { defaultValue: schema.default } : {})
      };
    case "boolean":
      return {
        kind: "boolean",
        name,
        label,
        ...(description ? { description } : {}),
        required,
        ...(typeof schema.default === "boolean" ? { defaultValue: schema.default } : {})
      };
    default:
      return null;
  }
}

export function deriveStructuredActionInputSpec(schema: unknown): StructuredActionInputSpec | null {
  if (!isRecord(schema) || schema.type !== "object") {
    return null;
  }

  const rawProperties = schema.properties;
  if (!isRecord(rawProperties)) {
    return {
      fields: []
    };
  }

  const requiredFields = new Set(
    Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : []
  );
  const fields: StructuredActionInputField[] = [];

  for (const [name, propertySchema] of Object.entries(rawProperties)) {
    if (!isRecord(propertySchema)) {
      return null;
    }

    const field = readStructuredField(name, propertySchema, requiredFields.has(name));
    if (!field) {
      return null;
    }
    fields.push(field);
  }

  return {
    fields
  };
}

export function initializeStructuredActionInputValues(spec: StructuredActionInputSpec): StructuredActionInputValues {
  return Object.fromEntries(
    spec.fields.map((field) => {
      switch (field.kind) {
        case "string":
        case "string_enum":
          return [field.name, field.defaultValue ?? ""];
        case "number":
        case "integer":
          return [field.name, field.defaultValue !== undefined ? String(field.defaultValue) : ""];
        case "boolean":
          return [field.name, field.defaultValue === undefined ? "" : field.defaultValue ? "true" : "false"];
      }
    })
  );
}

export function buildStructuredActionInput(
  spec: StructuredActionInputSpec,
  values: StructuredActionInputValues
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const output: Record<string, unknown> = {};

  for (const field of spec.fields) {
    const rawValue = values[field.name] ?? "";
    const normalized = rawValue.trim();

    if (field.kind === "boolean") {
      if (normalized.length === 0) {
        if (field.required) {
          return { ok: false, error: `Field "${field.label}" is required.` };
        }
        continue;
      }

      output[field.name] = normalized === "true";
      continue;
    }

    if (normalized.length === 0) {
      if (field.required) {
        return { ok: false, error: `Field "${field.label}" is required.` };
      }
      continue;
    }

    if (field.kind === "number" || field.kind === "integer") {
      const parsed = Number(normalized);
      if (!Number.isFinite(parsed)) {
        return { ok: false, error: `Field "${field.label}" must be a valid number.` };
      }
      if (field.kind === "integer" && !Number.isInteger(parsed)) {
        return { ok: false, error: `Field "${field.label}" must be an integer.` };
      }
      output[field.name] = parsed;
      continue;
    }

    output[field.name] = rawValue;
  }

  return {
    ok: true,
    value: output
  };
}
