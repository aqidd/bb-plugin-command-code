/**
 * Command Code speaks ACP through this plugin's own adapter binary, so the
 * SDK's generic ACP bridge is the whole host surface — BB drives it, it
 * drives `command-code-acp`, and that drives `cmd`.
 *
 * The command-code dialect adds account maintenance (Usage panel) on top of
 * the generic ACP behavior.
 */
import {
  experimental_acpProviderBridge,
  experimental_registerAcpDialect,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { readAccount, readUsage } from "./src/usage.mjs";

experimental_registerAcpDialect({
  id: "command-code",
  maintenance: {
    loginCommand: "cmd login",
    installer: () => ({
      command: "npm",
      args: ["i", "-g", "command-code"],
      displayCommand: "npm i -g command-code",
    }),
    readAccount,
    readUsage,
  },
});

export { experimental_acpProviderBridge as experimental_providerBridge };