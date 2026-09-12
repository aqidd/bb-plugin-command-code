import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";

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
    modelCli: {
      listArgs: ["--list-models"],
      primaryModels: [],
      selectFlag: "--model",
    },
    permissionCli: {
      // Both write modes land on the same switch; only the setting narrows it.
      full: allowWrites ? ["--yolo"] : ["--readonly"],
      workspaceWrite: allowWrites ? ["--yolo"] : ["--readonly"],
    },
    // No reasoningCli: cmd's `--effort` levels vary per model (the default
    // model accepts only high/max) and it exits 1 on an unsupported one, so a
    // static ladder would break every thread. Each model's own default applies.
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
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      // "auto" is deliberately absent: the SDK's ACP bridge has no arm for it.
      permissionModes: ["accept-edits", "full"],
      // Inert single entry: the ladder must be non-empty, but effort is left
      // to the model (see the reasoningCli note in buildLaunchSpec).
      reasoningLevels: ["medium"],
    },
    models: { fallback: [], scope: "host" },
    composerActions: [],
    experimental_bridgeOptions: {
      acpDialect: "generic",
      acpLaunchSpec: buildLaunchSpec(true, ""),
    },
    deriveProviderOptions(ctx) {
      const allowWrites = ctx.settings.allowWrites !== false;
      const executable = String(ctx.settings.executable ?? "").trim();
      return { acpLaunchSpec: buildLaunchSpec(allowWrites, executable) };
    },
  });

  void settings.get().then((values) => {
    bb.log.info(
      `Command Code provider registered (writes ${values.allowWrites ? "allowed" : "blocked"})`,
    );
  });
}
