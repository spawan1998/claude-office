import { query } from "@anthropic-ai/claude-agent-sdk";
const t0 = Date.now();
try {
  for await (const m of query({ prompt: "Use the ToolSearch tool to look for any tools whose names start with mcp__ (for example Jira, Confluence, Outlook, Teams). Then reply with a plain list of MCP server names and 5 example tool names you found, or say NONE.", options: { cwd: "/Users/pavan/Desktop/hilabs/claude-office/workspace", maxTurns: 6, env: { ...process.env, CLAUDE_CODE_MCP_CONNECTOR_PREWAIT_MS: "15000" } } })) {
    if (m.type === "system" && m.subtype === "init") {
      console.log("INIT mcp_servers=", JSON.stringify(m.mcp_servers), "tools=", m.tools.length, m.tools.filter(t=>t.startsWith("mcp__")).length);
    } else if (m.type === "system") {
      console.log("SYS", m.subtype, JSON.stringify(m).slice(0,300));
    } else if (m.type === "assistant") {
      for (const b of m.message.content) { if (b.type === "text") console.log("TEXT:", b.text.slice(0,800)); if (b.type === "tool_use") console.log("TOOL:", b.name, JSON.stringify(b.input).slice(0,150)); }
    } else if (m.type === "result") {
      console.log("RESULT", m.subtype, "turns=", m.num_turns, "ms=", Date.now()-t0);
    }
  }
} catch (e) { console.error("ERR", e?.message || e); }
