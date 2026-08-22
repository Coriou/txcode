import { describe, expect, it } from "vite-plus/test";

import {
  APP_BASE_NAME,
  MOBILE_APP_DISPLAY_NAMES,
  MOBILE_CLIENT_LABEL,
  resolveMobileAppName,
  resolveMobileStageLabel,
} from "./mobileBranding";

describe("resolveMobileStageLabel", () => {
  it.each([
    ["development", "Dev"],
    ["preview", "Nightly"],
    ["production", "Alpha"],
    [undefined, "Alpha"],
  ])("maps %s builds to %s", (appVariant, expected) => {
    expect(resolveMobileStageLabel(appVariant)).toBe(expected);
  });
});

describe("resolveMobileAppName", () => {
  it.each([
    ["development", "Tx Code Dev"],
    ["preview", "Tx Code Preview"],
    ["production", "Tx Code"],
    [undefined, "Tx Code"],
  ])("maps %s builds to %s", (appVariant, expected) => {
    expect(resolveMobileAppName(appVariant)).toBe(expected);
  });

  it("derives every stage display name and the client label from the base name", () => {
    expect(APP_BASE_NAME).toBe("Tx Code");
    for (const displayName of Object.values(MOBILE_APP_DISPLAY_NAMES)) {
      expect(displayName).toContain(APP_BASE_NAME);
    }
    expect(MOBILE_CLIENT_LABEL).toBe(`${APP_BASE_NAME} Mobile`);
  });
});
