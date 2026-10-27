import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export type ThreadListProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "enabled" | "displayName" | "accentColor" | "iconUrl"
>;

const capabilityKeys = [
  "threadSettlement",
  "threadSnooze",
  "threadPinning",
  "threadAutoSettleOptOut",
  "threadPinReorder",
  "threadActiveReorder",
  "threadTitleRegeneration",
] as const;

function selectEnvironment(config: ServerConfig) {
  return {
    providers: config.providers.map(
      ({ instanceId, driver, enabled, displayName, accentColor, iconUrl }) => ({
        instanceId,
        driver,
        enabled,
        displayName,
        accentColor,
        iconUrl,
      }),
    ),
    machineKind: resolveEnvironmentMachineKind(config),
    capabilities: config.environment.capabilities,
    // Fork-local: rows space snoozes with the minutes this environment reports.
    snoozeSpacingMinutes: config.settings.snoozeSpacingMinutes,
  };
}

type ListEnvironment = ReturnType<typeof selectEnvironment>;

function sameProviders(
  left: ReadonlyArray<ThreadListProvider>,
  right: ReadonlyArray<ThreadListProvider>,
) {
  return (
    left.length === right.length &&
    left.every((provider, index) => {
      const other = right[index]!;
      return (
        provider.instanceId === other.instanceId &&
        provider.driver === other.driver &&
        provider.enabled === other.enabled &&
        provider.displayName === other.displayName &&
        provider.accentColor === other.accentColor &&
        provider.iconUrl === other.iconUrl
      );
    })
  );
}

function collectEnvironments(environments: ReadonlyMap<EnvironmentId, ListEnvironment>) {
  const providersByEnvironmentId = new Map<EnvironmentId, ReadonlyArray<ThreadListProvider>>();
  const machineByEnvironmentId = new Map<EnvironmentId, EnvironmentMachineKind>();
  const settlementEnvironmentIds = new Set<EnvironmentId>();
  const snoozeEnvironmentIds = new Set<EnvironmentId>();
  const pinningEnvironmentIds = new Set<EnvironmentId>();
  const autoSettleOptOutEnvironmentIds = new Set<EnvironmentId>();
  const pinReorderEnvironmentIds = new Set<EnvironmentId>();
  const activeReorderEnvironmentIds = new Set<EnvironmentId>();
  const titleRegenerationEnvironmentIds = new Set<EnvironmentId>();
  // Fork-local: one spacing value per environment, for the rows that offer a menu.
  const snoozeSpacingMinutesByEnvironment = new Map<EnvironmentId, number>();
  for (const [id, { providers, machineKind, capabilities, snoozeSpacingMinutes }] of environments) {
    providersByEnvironmentId.set(id, providers);
    machineByEnvironmentId.set(id, machineKind);
    snoozeSpacingMinutesByEnvironment.set(id, snoozeSpacingMinutes);
    if (capabilities.threadSettlement === true) settlementEnvironmentIds.add(id);
    if (capabilities.threadSnooze === true) snoozeEnvironmentIds.add(id);
    if (capabilities.threadAutoSettleOptOut === true) autoSettleOptOutEnvironmentIds.add(id);
    if (capabilities.threadPinning === true) pinningEnvironmentIds.add(id);
    if (capabilities.threadPinReorder === true) pinReorderEnvironmentIds.add(id);
    if (capabilities.threadActiveReorder === true) activeReorderEnvironmentIds.add(id);
    if (capabilities.threadTitleRegeneration === true) titleRegenerationEnvironmentIds.add(id);
  }
  return {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinningEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
    // Fork-local: rows look up their environment's spacing through this map.
    snoozeSpacingMinutesByEnvironment,
  };
}

export function createThreadListEnvironmentsAtom(
  configsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>,
) {
  let previous = new Map<EnvironmentId, ListEnvironment>();
  let result = collectEnvironments(previous);
  return Atom.make((get) => {
    const configs = get(configsAtom);
    const next = new Map<EnvironmentId, ListEnvironment>();
    let changed = configs.size !== previous.size;
    for (const [id, config] of configs) {
      const selected = selectEnvironment(config);
      const prior = previous.get(id);
      if (prior && sameProviders(prior.providers, selected.providers)) {
        selected.providers = prior.providers;
      }
      const unchanged =
        prior &&
        prior.providers === selected.providers &&
        prior.machineKind === selected.machineKind &&
        // Fork-local: a spacing change must reach the rows through a new list.
        prior.snoozeSpacingMinutes === selected.snoozeSpacingMinutes &&
        capabilityKeys.every(
          (key) => (prior.capabilities[key] === true) === (selected.capabilities[key] === true),
        );
      next.set(id, unchanged ? prior : selected);
      if (!unchanged) changed = true;
    }
    if (changed) {
      previous = next;
      result = collectEnvironments(next);
    }
    return result;
  }).pipe(Atom.withLabel("thread-list-environments"));
}
