/**
 * Command Code speaks ACP through this plugin's own adapter binary, so the
 * SDK's generic ACP bridge is the whole host surface — BB drives it, it
 * drives `command-code-acp`, and that drives `cmd`.
 */
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
