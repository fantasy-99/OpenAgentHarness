import { describe, expect, it } from "vitest";

import {
  buildStructuredActionInput,
  deriveStructuredActionInputSpec,
  initializeStructuredActionInputValues
} from "../apps/web/src/app/action-input-form";

describe("action input form helpers", () => {
  it("derives a structured form spec from a simple object schema", () => {
    const spec = deriveStructuredActionInputSpec({
      type: "object",
      required: ["mode", "enabled"],
      properties: {
        mode: {
          type: "string",
          title: "Mode"
        },
        enabled: {
          type: "boolean",
          description: "Enable the action."
        },
        retries: {
          type: "integer",
          default: 2
        },
        target: {
          enum: ["dev", "prod"],
          default: "dev"
        }
      }
    });

    expect(spec).toEqual({
      fields: [
        {
          kind: "string",
          name: "mode",
          label: "Mode",
          required: true
        },
        {
          kind: "boolean",
          name: "enabled",
          label: "Enabled",
          description: "Enable the action.",
          required: true
        },
        {
          kind: "integer",
          name: "retries",
          label: "Retries",
          required: false,
          defaultValue: 2
        },
        {
          kind: "string_enum",
          name: "target",
          label: "Target",
          required: false,
          options: ["dev", "prod"],
          defaultValue: "dev"
        }
      ]
    });
  });

  it("initializes structured form values from defaults", () => {
    const spec = deriveStructuredActionInputSpec({
      type: "object",
      properties: {
        retries: {
          type: "integer",
          default: 2
        },
        enabled: {
          type: "boolean",
          default: true
        }
      }
    });

    expect(spec).not.toBeNull();
    expect(initializeStructuredActionInputValues(spec!)).toEqual({
      retries: "2",
      enabled: "true"
    });
  });

  it("builds structured input payloads and validates required fields", () => {
    const spec = deriveStructuredActionInputSpec({
      type: "object",
      required: ["mode", "enabled"],
      properties: {
        mode: {
          type: "string"
        },
        enabled: {
          type: "boolean"
        },
        retries: {
          type: "integer"
        }
      }
    });

    expect(spec).not.toBeNull();
    expect(
      buildStructuredActionInput(spec!, {
        mode: "quick",
        enabled: "false",
        retries: "3"
      })
    ).toEqual({
      ok: true,
      value: {
        mode: "quick",
        enabled: false,
        retries: 3
      }
    });

    expect(
      buildStructuredActionInput(spec!, {
        mode: "",
        enabled: "",
        retries: ""
      })
    ).toEqual({
      ok: false,
      error: 'Field "Mode" is required.'
    });
  });

  it("falls back to raw JSON mode for unsupported nested schemas", () => {
    expect(
      deriveStructuredActionInputSpec({
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              mode: {
                type: "string"
              }
            }
          }
        }
      })
    ).toBeNull();
  });
});
