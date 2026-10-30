import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  migrateLegacyNotificationSettings,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  OmpSettings,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeProviderInstanceEnvironment = Schema.encodeSync(ProviderInstanceEnvironment);
const decodeProviderInstanceEnvironment = Schema.decodeSync(ProviderInstanceEnvironment);
// The environment variable shape builds released before secret references decode.
const decodeStringOnlyEnvironment = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
  ),
);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("ServerSettings secret providers", () => {
  const onePassword = (account: string) => ({
    kind: "one_password",
    label: "Personal",
    config: { account },
  });

  it("keeps an unknown kind or a longer label from invalidating the rest of the settings", () => {
    const openbao = { kind: "openbao", label: "V".repeat(65), config: { address: "https://x" } };
    const decoded = decodeServerSettings({
      worktreesDirectory: "/work",
      secretProviders: { vault: openbao, personal: onePassword("my.1password.com") },
    });
    expect(decoded.worktreesDirectory).toBe("/work");
    expect(encodeServerSettings(decoded).secretProviders).toEqual({
      vault: openbao,
      personal: onePassword("my.1password.com"),
    });
  });

  it("accepts slug ids and null removals but no id that is not a slug", () => {
    expect(
      decodeServerSettingsPatch({
        secretProviders: { "1password": onePassword("my.1password.com"), work: null },
      }).secretProviders,
    ).toEqual({ "1password": onePassword("my.1password.com"), work: null });
    for (const id of ["", "My Vault", "a/b", "-vault"]) {
      expect(() =>
        decodeServerSettingsPatch({ secretProviders: { [id]: onePassword("my.1password.com") } }),
      ).toThrow();
    }
    expect(() =>
      decodeServerSettingsPatch({
        secretProviders: { work: { ...onePassword("my.1password.com"), label: "V".repeat(65) } },
      }),
    ).toThrow();
  });

  it("stores a provider environment secret reference in a layout older builds still decode", () => {
    const providerInstances = (secret: unknown) => ({
      codex: {
        driver: "codex",
        environment: [
          { name: "OPENAI_API_KEY", sensitive: true, value: "", secret },
          { name: "BASE_URL", value: "https://example.test" },
        ],
      },
    });
    const secret = { provider: "personal", reference: "op://Private/OpenAI/credential" };
    const environment = decodeServerSettings({ providerInstances: providerInstances(secret) })
      .providerInstances[ProviderInstanceId.make("codex")]?.environment;
    expect(environment).toEqual([
      { name: "OPENAI_API_KEY", value: secret, sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    const encoded = encodeProviderInstanceEnvironment(environment ?? []);
    expect(encoded).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true, secret },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);
    expect(decodeProviderInstanceEnvironment(encoded)).toEqual(environment);
    expect(decodeStringOnlyEnvironment(encoded)).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    for (const invalid of [
      { provider: "My Vault", reference: "op://a/b/c" },
      { provider: "personal", reference: " " },
      { provider: "personal", reference: "op://Private/OpenAI\n/credential" },
      { provider: "personal", reference: "x".repeat(1025) },
    ]) {
      expect(() =>
        decodeServerSettings({ providerInstances: providerInstances(invalid) }),
      ).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    // Fork driver defaults still apply: OMP ships disabled.
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("omp"), config: {} }),
    ).toBe(false);
    // Unknown fork drivers stay enabled.
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });

  it("decodes OMP instance settings", () => {
    const decodeOmpSettings = Schema.decodeUnknownSync(OmpSettings);
    expect(decodeOmpSettings({})).toMatchObject({
      enabled: false,
      binaryPath: "omp",
      launchArgs: "",
      customModels: [],
    });

    expect(
      decodeOmpSettings({
        binaryPath: "/opt/omp",
        launchArgs: "--config /tmp/omp.yml",
        customModels: ["extension/model"],
      }),
    ).toMatchObject({
      binaryPath: "/opt/omp",
      launchArgs: "--config /tmp/omp.yml",
      customModels: ["extension/model"],
    });
  });


  it("enables only the stable bindings by default", () => {
    const enabledByDefault = (driver: string) =>
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make(driver), config: {} });
    expect(enabledByDefault("codex")).toBe(true);
    expect(enabledByDefault("claudeAgent")).toBe(true);
    for (const driver of ["cursor", "grok", "muse", "pi", "omp", "opencode", "antigravity"]) {
      expect(enabledByDefault(driver)).toBe(false);
    }
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("ServerSettings project overrides across versions", () => {
  it("sends back an override key from a newer server when an older client edits the entry", () => {
    const projectId = ProjectId.make("project-a");
    // As an older client reads a newer server's settings, with one key it does not know.
    const entry = decodeServerSettings({
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, addedByNewerServer: { mode: "kept" } },
      },
    }).projectSettingsOverrides[projectId];

    const sent = encodeServerSettingsPatch({
      projectSettingsOverrides: { [projectId]: { ...entry, defaultAutoPull: false } },
    });

    expect(decodeServerSettingsPatch(sent).projectSettingsOverrides?.[projectId]).toEqual({
      defaultAutoPull: false,
      addedByNewerServer: { mode: "kept" },
    });
  });
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});


// Fork-local regression: V1's separate observer ignored the encoded upstream Off.
describe("notification preference consolidation", () => {
  const migrate = (raw: unknown) => decodeClientSettings(migrateLegacyNotificationSettings(raw));
  it("keeps V1 approval-only opt-in without enabling other events or sound", () => {
    const settings = migrate({ notificationMode: "off", notifyOnApprovalRequested: true });
    expect(settings.notificationMode).toBe("notifications");
    expect(settings.notifyOnApprovalRequested).toBe(true);
    expect(settings.notifyOnTurnCompleted).toBe(false);
    expect(settings.notifyOnFailure).toBe(false);
    expect(settings.notifyOnUserInputRequested).toBe(false);
  });
  it("keeps fresh and legacy all-off installations silent", () => {
    expect(migrate({}).notificationMode).toBe("off");
    expect(migrate({ notifyOnApprovalRequested: false }).notificationMode).toBe("off");
  });
  it("keeps existing upstream alerts even when custom toggles defaulted off", () => {
    const settings = migrate({
      notificationMode: "notifications",
      notifyOnApprovalRequested: false,
    });
    expect(settings.notificationMode).toBe("notifications");
    expect(settings.notifyOnApprovalRequested).toBe(true);
    expect(settings.notifyOnTurnCompleted).toBe(true);
  });
  it("combines upstream sound with selected legacy system alerts", () => {
    const settings = migrate({ notificationMode: "sound", notifyOnApprovalRequested: true });
    expect(settings.notificationMode).toBe("notifications-and-sound");
    expect(settings.notifyOnApprovalRequested).toBe(true);
    expect(settings.notifyOnTurnCompleted).toBe(false);
  });
  it("preserves explicit Off across encoding and unrelated saves after migration", () => {
    const enabled = migrate({ notificationMode: "off", notifyOnApprovalRequested: true });
    const off = { ...enabled, notificationMode: "off" as const, wordWrap: false };
    const reloaded = migrate(encodeClientSettings(off));
    expect(reloaded.notificationPreferencesVersion).toBe(1);
    expect(reloaded.notificationMode).toBe("off");
    expect(reloaded.notifyOnApprovalRequested).toBe(true);
    expect(reloaded.wordWrap).toBe(false);
  });
  it("does not convert invalid settings into silent defaults", () => {
    expect(() => migrate({ notificationPreferencesVersion: 2 })).toThrow();
    expect(() => migrate({ notificationPreferencesVersion: "1" })).toThrow();
    expect(() => migrate({ notificationMode: "invalid" })).toThrow();
    expect(() =>
      migrate({ notificationMode: "notifications", notificationFocusRule: "invalid" }),
    ).toThrow();
    expect(() => migrate({ notifyOnApprovalRequested: "true" })).toThrow();
  });
});

it("preserves foreground consent when consolidating mixed V1 observers", () => {
  const upstreamOnly = decodeClientSettings(
    migrateLegacyNotificationSettings({
      notificationMode: "notifications",
      notifyOnApprovalRequested: false,
    }),
  );
  expect(upstreamOnly.notificationFocusRule).toBe("unfocused");
  const mixed = decodeClientSettings(
    migrateLegacyNotificationSettings({
      notificationMode: "notifications",
      notifyOnApprovalRequested: true,
      notificationFocusRule: "always",
    }),
  );
  expect(mixed.notifyOnTurnCompleted).toBe(true);
  expect(mixed.notificationForegroundKinds).toEqual(["approval-requested"]);
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("inherits the machine value when the project has no override", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });

  it("lets a project enable an instance the machine disabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(true);
  });

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });

  it("always resolves to the machine value when no project is in scope", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, null, instanceId)).toBe(true);
  });

  it("falls back to the unconfigured default when the instance has no settings entry", () => {
    const settings: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {} };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(
      resolveProjectProviderInstanceEnabled(settings, null, instanceId),
    );

    const overridden = {
      ...settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(overridden, projectId, instanceId)).toBe(true);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("decodes a visibility update scoped to a provider instance and model", () => {
    const patch = { setModelsHidden: [{ provider: "codex_work", model: "sol", hidden: false }] };
    expect(decodeServerSettingsPatch(patch)).toEqual(patch);
    expect(() =>
      decodeServerSettingsPatch({ setModelsHidden: [{ provider: "codex_work", model: "sol" }] }),
    ).toThrow();
  });
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });

  it("round trips favorites and hidden models keyed by provider instance", () => {
    const input = {
      favorites: [{ provider: "codex_work", model: "sol" }],
      providerModelPreferences: { codex_work: { hiddenModels: ["astra"], modelOrder: ["sol"] } },
    };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
    expect(decodeServerSettingsPatch({ migrateModelPreferences: input })).toEqual({
      migrateModelPreferences: input,
    });
  });
});
