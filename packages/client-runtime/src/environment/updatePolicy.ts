import type { EnvironmentUpdatePolicy, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

// Fork-local: absent or unrecognized destination identity never implies upstream support.
export function supportsDestinationServerUpdate(
  policy: EnvironmentUpdatePolicy | undefined,
  desktopManaged = false,
): boolean {
  return (
    policy?.distribution === "t3" &&
    policy.serverUpdate === "supported" &&
    (!desktopManaged || policy.desktopUpdate === "supported")
  );
}

export function destinationServerUpdateSupported(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  const capabilities = descriptor?.capabilities;
  return (
    supportsDestinationServerUpdate(
      descriptor?.updatePolicy,
      capabilities?.serverSelfUpdate === "desktop-managed",
    ) &&
    capabilities?.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function destinationManualUpdateInfo(policy: EnvironmentUpdatePolicy | undefined) {
  return policy?.distribution === "txcode"
    ? {
        message: "Tx Code updates are installed manually on this machine.",
        url: "https://github.com/Coriou/txcode/releases",
      }
    : policy?.distribution === "t3"
      ? {
          message: "Update T3 Code manually on this machine.",
          url: "https://github.com/pingdotgg/t3code/releases",
        }
      : {
          message:
            "Update support is unknown. Follow the installation instructions for this machine.",
          url: null,
        };
}
