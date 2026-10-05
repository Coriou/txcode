import * as Schema from "effect/Schema";
import {
  ClientSettingsSchema,
  migrateLegacyNotificationSettings,
  type ClientSettings,
} from "@t3tools/contracts";

import {
  getLocalStorageItem,
  setLocalStorageItem,
  LocalStorageOperationError,
} from "./hooks/useLocalStorage";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  const raw = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, Schema.Unknown);
  if (raw === null) return null;
  try {
    return decodeClientSettings(migrateLegacyNotificationSettings(raw));
  } catch (cause) {
    throw new LocalStorageOperationError({
      operation: "decode",
      storageKey: CLIENT_SETTINGS_STORAGE_KEY,
      cause,
    });
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
