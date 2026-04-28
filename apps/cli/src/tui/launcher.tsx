import React from "react";
import { render } from "ink";

import type { OahConnection } from "../api/oah-api.js";
import { OahTui } from "./OahTui.js";

const ENABLE_MODIFY_OTHER_KEYS = "\u001b[>4;2m";
const DISABLE_MODIFY_OTHER_KEYS = "\u001b[>4m";

function shouldEnableModifyOtherKeys() {
  return Boolean(process.stdout.isTTY && process.env.OAH_TUI_NO_EXTENDED_KEYS !== "1");
}

export async function launchTui(connection: OahConnection): Promise<void> {
  const modifyOtherKeys = shouldEnableModifyOtherKeys();
  if (modifyOtherKeys) {
    process.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
  }
  const instance = render(<OahTui connection={connection} />, {
    alternateScreen: false,
    kittyKeyboard: {
      mode: "enabled",
      flags: ["disambiguateEscapeCodes"]
    },
    maxFps: 20
  });
  if (modifyOtherKeys) {
    setImmediate(() => {
      process.stdout.write(ENABLE_MODIFY_OTHER_KEYS);
    });
  }
  try {
    await instance.waitUntilExit();
  } finally {
    if (modifyOtherKeys) {
      process.stdout.write(DISABLE_MODIFY_OTHER_KEYS);
    }
  }
}
