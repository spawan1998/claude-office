// End-to-end check of the agent + approval/question relay without WhatsApp.
// Uses a scratch state dir so it never touches the real session.
//   CLAUDE_OFFICE_STATE=/tmp/claude-office-e2e node bin/e2e-agent.ts
import { Agent, type Prompter } from "../src/agent.ts";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const seen: string[] = [];

const prompter: Prompter = {
  askApproval: async (req) => {
    log("APPROVAL", req.toolName, "|", req.summary, "|", req.detail.slice(0, 120).replace(/\n/g, " "));
    log("  WHY:", req.why ?? "(none)", "| CONTEXT:", (req.context ?? "(none)").slice(0, 200).replace(/\n/g, " "));
    seen.push("approval:" + req.toolName);
    // approve the file creation, deny the deletion to prove both paths work
    if (/rm /.test(req.detail)) return { kind: "deny", message: "The user declined this action and said: keep the file, just tell me its path." };
    return { kind: "once" };
  },
  askQuestions: async (questions) => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      log("QUESTION", q.header, "|", q.question, "|", q.options.map((o) => o.label).join(" / "));
      seen.push("question");
      answers[q.question] = q.options[q.options.length - 1].label; // always pick the last option
    }
    return answers;
  },
  progress: (t) => log("PROGRESS", t.slice(0, 160).replace(/\n/g, " ")),
  activity: (t) => log("ACTIVITY", t),
};

const agent = new Agent();
agent.newSession();
const r1 = await agent.run(
  "Step 1: use a shell command to write the text 'hello from claude-office' to /tmp/claude-office-e2e.txt (no approval is needed for writes). " +
  "Step 2: then use the AskUserQuestion tool to ask me whether to keep the file or delete it, with exactly two options: 'Keep' and 'Delete'. " +
  "Step 3: do what I answered (deleting is destructive, so it prompts for approval). Finally reply in one short sentence with what happened.",
  prompter,
);
log("RESULT1", JSON.stringify({ ok: r1.ok, turns: r1.turns, ms: r1.durationMs, text: r1.text.slice(0, 300) }));

const r2 = await agent.run("What was the path of the file from the previous step? Answer with just the path.", prompter);
log("RESULT2 (resume check)", JSON.stringify({ ok: r2.ok, turns: r2.turns, text: r2.text.slice(0, 200), sameSession: r2.sessionId === r1.sessionId }));
log("SEEN", seen.join(", "));
