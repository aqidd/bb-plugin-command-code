import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * `cmd -p` has no interactive permission channel: file writes and shell
 * commands are either all allowed (`--yolo`) or all refused. BB's per-tool
 * approval therefore cannot apply to this provider, so the choice is exposed
 * once, as a setting, instead of pretending to be per-call. See README.
 */
function buildLaunchSpec(allowWrites: boolean, executable: string): JsonValue {
  return {
    displayName: "Command Code",
    command: "command-code-acp",
    args: allowWrites ? ["--yolo"] : ["--readonly"],
    env: executable === "" ? {} : { COMMAND_CODE_EXECUTABLE: executable },
    permissionCli: {
      // Both write modes land on the same switch; only the setting narrows it.
      full: allowWrites ? ["--yolo"] : ["--readonly"],
      workspaceWrite: allowWrites ? ["--yolo"] : ["--readonly"],
    },
    // No modelCli or reasoningCli: the adapter advertises models and each
    // model's own `--effort` ladder as ACP session config options, which BB
    // only discovers when no modelCli is set.
    nativeSkillRoots: {
      user: [".command-code/skills", ".claude/skills", ".agents/skills"],
      project: [".command-code/skills", ".claude/skills", ".agents/skills"],
    },
  } satisfies JsonValue;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    allowWrites: {
      type: "boolean",
      default: true,
      label: "Allow file writes and shell commands",
      description:
        "Command Code's headless mode cannot prompt per tool call. On, it runs with --yolo. Off, it can only read.",
    },
    executable: {
      type: "string",
      default: "",
      label: "Command Code executable",
      description: "Path to the `cmd` binary. Leave empty to use whatever is on PATH.",
    },
  });

  bb.providers.register({
    id: "command-code",
    displayName: "Command Code",
    family: "acp",
    icon: "./assets/icon.svg",
    strings: {
      signInHint: "Run `cmd login` on the machine to sign in to Command Code.",
      expiredHint: "Your Command Code session expired. Run `cmd login`, then reload.",
      installUrl: "https://github.com/aqidd/bb-plugin-command-code#install",
      iconTint: { light: "#1F2937", dark: "#E5E7EB" },
    },
    // Hidden until `command-code-acp` is on the machine's PATH.
    experimental_visibility: "installed",
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      // "auto" is deliberately absent: the SDK's ACP bridge has no arm for it.
      permissionModes: ["accept-edits", "full"],
      // Fallback only: each model's real ladder comes from the adapter's
      // thought_level config option (see buildLaunchSpec).
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    models: { fallback: [], scope: "host" },
    composerActions: [],
    experimental_bridgeOptions: {
      acpDialect: "command-code",
      acpLaunchSpec: buildLaunchSpec(true, ""),
    },
    deriveProviderOptions(ctx) {
      const allowWrites = ctx.settings.allowWrites !== false;
      const executable = String(ctx.settings.executable ?? "").trim();
      return { acpDialect: "command-code", acpLaunchSpec: buildLaunchSpec(allowWrites, executable) };
    },
  });

  registerUsageSource(bb);

  void settings.get().then((values) => {
    bb.log.info(
      `Command Code provider registered (writes ${values.allowWrites ? "allowed" : "blocked"})`,
    );
  });
}

/**
 * The Usage panel discovers sources through the provider-usage.v1 resource
 * RPCs (same contract the built-in provider plugins implement). Inventory is
 * metadata-only; measurements delegate to the core provider/usage path, which
 * the host bridge answers from src/usage.mjs.
 */
function registerUsageSource(bb: BbPluginApi) {
  const planSchema = z.object({
    id: z.string().min(1),
    multiplier: z.number().int().positive().nullable(),
  });
  const usageFields = {
    plan: planSchema.nullable().default(null),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  };
  const windowSchema = z.object({
    kind: z.enum(["five-hour", "daily", "weekly", "custom"]).default("custom"),
    id: z.string().min(1),
    label: z.string().min(1),
    usedPercent: z.number().nonnegative(),
    resetsAt: z.string().nullable(),
    model: z.string().nullable().default(null),
    cost: z
      .object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() })
      .nullable()
      .default(null),
  });
  const usageSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), ...usageFields, windows: z.array(windowSchema) }),
    z.object({ status: z.literal("not_installed"), ...usageFields }),
    z.object({ status: z.literal("unauthenticated"), ...usageFields }),
    z.object({ status: z.literal("expired"), ...usageFields }),
    z.object({ status: z.literal("error"), ...usageFields, message: z.string() }),
  ]);
  const contract = defineRpcContract({
    "provider-usage.v1.listResources": {
      input: z.object({}),
      output: z.object({
        label: z.string().min(1).optional(),
        resources: z.array(
          z.object({
            accountKey: z.string().min(1).nullable().default(null),
            id: z.string().min(1),
            providerId: z.string().min(1),
            label: z.string().min(1),
            scope: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("shared") }),
              z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
            ]),
          }),
        ),
      }),
    },
    "provider-usage.v1.getResource": {
      input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
      output: z.object({
        accountKey: z.string().min(1).nullable().default(null),
        observedAt: z.number().int().nonnegative().nullable(),
        usage: usageSchema,
      }),
    },
  });

  bb.rpc.register(
    contract,
    {
      async "provider-usage.v1.listResources"() {
        const hosts = await bb.sdk.hosts.list();
        const resources = (
          await Promise.all(
            hosts.map(async (host) => {
              const providers = await bb.sdk.providers
                .list({ hostId: host.id, capability: "usage" })
                .catch(() => []);
              return providers
                .filter((p) => p.id === "command-code" && p.pluginId === "command-code")
                .map((p) => ({
                  id: JSON.stringify([host.id, p.id]),
                  accountKey: null,
                  providerId: p.id,
                  label: p.displayName,
                  scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
                }));
            }),
          )
        ).flat();
        return { resources };
      },
      async "provider-usage.v1.getResource"({ resourceId, refresh }) {
        const [hostId, providerId] = z
          .tuple([z.string().min(1), z.string().min(1)])
          .parse(JSON.parse(resourceId));
        const host = await bb.sdk.hosts.get({ hostId });
        if (host.status === "disconnected") {
          return {
            accountKey: null,
            observedAt: null,
            usage: usageSchema.parse({
              status: "error",
              message: "Machine is disconnected.",
              accountEmail: null,
              planLabel: null,
            }),
          };
        }
        const providers = await bb.sdk.providers.list({ hostId, capability: "usage" });
        if (!providers.some((p) => p.id === providerId)) {
          throw new Error("Usage resource no longer exists.");
        }
        const usage = (await bb.sdk.system.usageLimits({ hostId, providerId, refresh }))[providerId];
        if (!usage) throw new Error("Provider returned no usage information.");
        return {
          accountKey: null,
          observedAt: usage.status === "ok" ? Date.now() : null,
          usage: usageSchema.parse({ ...usage, plan: null }),
        };
      },
    },
    { experimental_discoverable: true },
  );
}
