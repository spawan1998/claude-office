// Entry point: link WhatsApp, start the router, announce readiness.
import { Bridge } from "./bridge.ts";
import { config } from "./config.ts";
import { WhatsApp } from "./whatsapp.ts";

async function main(): Promise<void> {
  console.log(new Date().toISOString().slice(11,19), `claude-office starting. workspace=${config.workspace} state=${config.stateDir} parallel=${config.maxParallel} taskGroups=${config.taskGroups}`);
  const wa = new WhatsApp();
  const bridge = new Bridge(wa);
  let announced = false;

  wa.allowGroup = (jid) => bridge.isTaskGroup(jid);
  wa.onMessage = (m) => { bridge.handle(m).catch((e) => console.error("handle failed", e)); };
  wa.onReady = () => {
    if (announced) return;
    announced = true;
    bridge.onConnected().catch((e) => console.error("startup reconcile failed", e));
    const jid = wa.selfChatJid;
    if (jid && process.env.CLAUDE_OFFICE_QUIET !== "true") {
      wa.send(jid, `Online. ${config.taskGroups ? `Each instruction here starts its own task group (max ${config.maxParallel} at once).` : "Sequential mode."} Send /help for commands.`).catch(() => {});
    }
  };
  await wa.connect();

  const shutdown = () => { console.log("shutting down"); wa.stop(); setTimeout(() => process.exit(0), 500); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
