import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

// Fork-local: no automatic update destination is qualified for this distribution.
export const destinationUpdatePolicy: NonNullable<ExecutionEnvironmentDescriptor["updatePolicy"]> =
  {
    distribution: "txcode",
    serverUpdate: "manual",
    desktopUpdate: "manual",
  };

export const MANUAL_UPDATE_REASON =
  "Tx Code updates are installed manually. Automatic server and desktop updates are not supported for this distribution; use the Tx Code update instructions.";
