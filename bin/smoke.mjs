import { query } from "@anthropic-ai/claude-agent-sdk";
const t0 = Date.now();
try {
  for await (const m of query({ prompt: "Reply with exactly: OK", options: { cwd: "/Users/pavan/Desktop/hilabs/claude-office/workspace", maxTurns: 2, settingSources: ["user"] } })) {
    if (m.type === "system" && m.subtype === "init") {
      console.log("INIT model=", m.model, "session=", m.session_id, "permissionMode=", m.permissionMode, "apiKeySource=", m.apiKeySource);
      console.log("MCP servers:", JSON.stringify(m.mcp_servers));
      console.log("tools:", (m.tools||[]).length, (m.tools||[]).filter(t=>t.startsWith("mcp__")).slice(0,40));
      console.log("plugins/skills:", JSON.stringify(m.plugins||[]), (m.slash_commands||[]).length);
    } else if (m.type === "result") {
      console.log("RESULT", m.subtype, "is_error=", m.is_error, "turns=", m.num_turns, "cost=", m.total_cost_usd, "text=", JSON.stringify(m.result).slice(0,200), "ms=", Date.now()-t0);
      if (m.is_error) console.log(JSON.stringify(m).slice(0,1500));
    }
  }
} catch (e) { console.error("ERR", e?.message || e); }
