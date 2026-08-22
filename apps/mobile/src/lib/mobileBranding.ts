export type MobileStageLabel = "Alpha" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Alpha";
}

/** User-facing app display name. Identifiers, schemes, and storage keys are unaffected. */
export const APP_BASE_NAME = "Tx Code";

export const MOBILE_APP_DISPLAY_NAMES = {
  development: `${APP_BASE_NAME} Dev`,
  preview: `${APP_BASE_NAME} Preview`,
  production: APP_BASE_NAME,
} as const;

export function resolveMobileAppName(appVariant: unknown): string {
  if (appVariant === "development") return MOBILE_APP_DISPLAY_NAMES.development;
  if (appVariant === "preview") return MOBILE_APP_DISPLAY_NAMES.preview;
  return MOBILE_APP_DISPLAY_NAMES.production;
}

export const MOBILE_CLIENT_LABEL = `${APP_BASE_NAME} Mobile`;
