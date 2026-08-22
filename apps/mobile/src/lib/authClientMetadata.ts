import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import { Platform } from "react-native";

import { MOBILE_CLIENT_LABEL } from "./mobileBranding";

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  return {
    label: MOBILE_CLIENT_LABEL,
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
    surface: "mobile",
    ...(appVersion ? { appVersion } : {}),
  };
}
