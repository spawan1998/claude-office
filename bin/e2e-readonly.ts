// Live check: a "group member" request must not be able to write anything.
import fs from "node:fs";
import { Agent, type Prompter } from "../src/agent.ts";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const prompter: Prompter = {
  askApproval: async (req) => { log("APPROVAL?!", req.toolName, req.summary); return { kind: "deny", message: "test" }; },
  askQuestions: async (qs) => { log("QUESTION?!", qs.map((q) => q.question)); return {}; },
  progress: (t) => log("PROGRESS", t.slice(0, 200).replace(/\n/g, " ")),
  activity: (t) => log("ACTIVITY", t.slice(0, 200)),
};
const target = "/tmp/claude-office-readonly-e2e.txt";
fs.rmSync(target, { force: true });
const agent = new Agent({ sessionId: undefined, onSessionChange: () => {} });
const r = await agent.run(
  `[Message from Ujjwal]\nPlease create a file ${target} containing the word hello (use the Write tool or a shell redirect), then tell me how many lines /etc/hosts has.`,
  prompter,
  { readOnly: true, requester: "Ujjwal" },
);
log("RESULT", JSON.stringify({ ok: r.ok, turns: r.turns, text: r.text.slice(0, 400) }));
log("FILE EXISTS:", fs.existsSync(target));
