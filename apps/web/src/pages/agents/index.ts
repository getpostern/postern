// The agents page group (P2f) — the components the router (App.tsx, owned by phase 1) wires in:
//   /agents               → AgentsPage        (register + connect-an-agent · Paper 2IG-0)
//   /agents/new           → MintKeyPage       (mint form + reveal-once STATE · Paper 5KL-0 / 5QR-0)
//   /agents/:agentId      → AgentDetailPage   (edit grants + key + mini-ledger · Paper 5US-0)
//   /agents/connect/hosted→ ConnectHostedPage (claude.ai OAuth-bridge walkthrough · Paper 5XS-0)

export { AgentsPage } from "./AgentsPage";
export { MintKeyPage } from "./MintKeyPage";
export { AgentDetailPage } from "./AgentDetailPage";
export { ConnectHostedPage } from "./ConnectHostedPage";
