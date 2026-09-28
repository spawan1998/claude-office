import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge, makeTitle, type Transport } from "../src/bridge.ts";
import type { AgentLike } from "../src/conversation.ts";
import type { Prompter, RunOptions, RunResult } from "../src/agent.ts";
import { config } from "../src/config.ts";

const SELF = "911234567890@s.whatsapp.net";

class FakeWA implements Transport {
  sent: { jid: string; text: string }[] = [];
  groups: { jid: string; subject: string }[] = [];
  selfChatJid = SELF;
  async send(jid: string, text: string) { this.sent.push({ jid, text }); }
  reactions: { id: string; emoji: string }[] = [];
  async setTyping() { /* noop */ }
  async react(key: { id: string }, emoji: string) { this.reactions.push({ id: key.id, emoji }); }
  files: { jid: string; file: string; caption?: string }[] = [];
  async sendFile(jid: string, file: string, caption?: string) { this.files.push({ jid, file, caption }); }
  async createGroup(subject: string) { const jid = `g${this.groups.length + 1}@g.us`; this.groups.push({ jid, subject }); return jid; }
  async renameGroup(jid: string, subject: string) { const g = this.groups.find((x) => x.jid === jid); if (g) g.subject = subject; }
  texts(jid: string) { return this.sent.filter((s) => s.jid === jid).map((s) => s.text); }
}

type Deferred = { resolve: (r: RunResult) => void; instruction: string; prompter: Prompter };

class FakeAgent implements AgentLike {
  running = false;
  startedAt = 0;
  sessionId: string | undefined;
  runs: string[] = [];
  lastOpts: RunOptions | undefined;
  static pending: Deferred[] = [];
  private onSession: (id: string) => void;
  constructor(onSession: (id: string) => void, sessionId?: string) { this.onSession = onSession; this.sessionId = sessionId; }
  async run(instruction: string, prompter: Prompter, opts?: RunOptions): Promise<RunResult> {
    this.running = true; this.startedAt = Date.now(); this.runs.push(instruction); this.lastOpts = opts;
    if (!this.sessionId) { this.sessionId = `s-${Math.random().toString(36).slice(2, 8)}`; this.onSession(this.sessionId); }
    const r = await new Promise<RunResult>((resolve) => FakeAgent.pending.push({ resolve, instruction, prompter }));
    this.running = false;
    return { ...r, sessionId: this.sessionId };
  }
  async cancel() { return this.running; }
  newSession() { this.sessionId = undefined; }
}

const ok = (text: string): RunResult => ({ text, ok: true, turns: 1, costUsd: 0, durationMs: 10 });
const tick = () => new Promise((r) => setTimeout(r, 5));
const msg = (chatJid: string, text: string) => {
  const id = Math.random().toString();
  return { chatJid, text, id, timestamp: 0, attachments: [] as string[], key: { remoteJid: chatJid, id, fromMe: true } };
};

function setup(limit = 3) {
  const wa = new FakeWA();
  const agents: FakeAgent[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-test-"));
  const storeFile = path.join(dir, "tasks.json");
  config.workspace = path.join(dir, "workspace");
  config.maxParallel = limit;
  config.taskGroups = true;
  FakeAgent.pending = [];
  const bridge = new Bridge(wa, { storeFile, agentFactory: (init) => { const a = new FakeAgent(init.onSessionChange, init.sessionId); agents.push(a); return a; } });
  return { wa, bridge, agents, storeFile };
}

test("instruction in self-chat starts a task in its own group and reports there", async () => {
  const { wa, bridge, agents } = setup();
  await bridge.handle(msg(SELF, "check why pda-backend build 464 failed on jenkins please"));
  await tick();
  assert.equal(wa.groups.length, 1);
  assert.match(wa.groups[0].subject, /^#1 · check why pda-backend build 464/);
  assert.match(wa.texts(SELF)[0], /Task #1 started/);
  const ran = agents.filter((a) => a.runs.length);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].runs[0], "check why pda-backend build 464 failed on jenkins please");
  FakeAgent.pending.shift()!.resolve(ok("Root cause: Maven Central 429."));
  await tick();
  const g = wa.texts(wa.groups[0].jid);
  assert.ok(g.some((t) => t.includes("Root cause: Maven Central 429.")), "result posted in group");
  assert.match(wa.groups[0].subject, /^✅ #1/);
  assert.ok(bridge.tasks[0].sessionId?.startsWith("s-"), "session id persisted");
  assert.equal(bridge.tasks[0].status, "done");
});

test("tasks run in parallel up to the limit, then wait for a slot", async () => {
  const { wa, bridge, agents } = setup(2);
  await bridge.handle(msg(SELF, "task one"));
  await bridge.handle(msg(SELF, "task two"));
  await bridge.handle(msg(SELF, "task three"));
  await tick();
  assert.equal(wa.groups.length, 3);
  assert.equal(agents.filter((a) => a.running).length, 2, "two running");
  assert.equal(FakeAgent.pending.length, 2);
  assert.ok(wa.texts("g3@g.us").some((t) => /Waiting for a free slot/.test(t)));
  FakeAgent.pending.shift()!.resolve(ok("one done"));
  await tick();
  assert.equal(agents.filter((a) => a.running).length, 2, "third started after a slot freed");
  assert.equal(agents.filter((a) => a.runs.length)[2].runs[0], "task three");
});

test("approval prompt is answered inside the task group; follow-ups reuse the same agent", async () => {
  const { wa, bridge, agents } = setup();
  await bridge.handle(msg(SELF, "delete the stale pod"));
  await tick();
  const d = FakeAgent.pending.shift()!;
  const ac = new AbortController();
  const approval = d.prompter.askApproval({ toolName: "Bash", summary: "destructive: kubectl delete", detail: "kubectl delete pod x", canAlways: false, why: "pod stuck terminating" }, ac.signal);
  await tick();
  const g = "g1@g.us";
  assert.ok(wa.texts(g).some((t) => /Approval #1/.test(t) && /Why:\* pod stuck terminating/.test(t)));
  await bridge.handle(msg(g, "yes"));
  assert.deepEqual(await approval, { kind: "once" });
  d.resolve(ok("deleted"));
  await tick();
  // follow-up in the group -> same conversation/agent, not a new group
  await bridge.handle(msg(g, "now check it came back"));
  await tick();
  assert.equal(wa.groups.length, 1);
  const ran = agents.filter((a) => a.runs.length);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].runs, ["delete the stale pod", "now check it came back"]);
  FakeAgent.pending.shift()!.resolve(ok("back"));
});

test("a group member's message is queued as an instruction and never answers an approval", async () => {
  const { wa, bridge, agents } = setup();
  await bridge.handle(msg(SELF, "delete the stale pod"));
  await tick();
  const d = FakeAgent.pending.shift()!;
  const ac = new AbortController();
  const approval = d.prompter.askApproval({ toolName: "Bash", summary: "destructive: kubectl delete", detail: "kubectl delete pod x", canAlways: false, why: "stuck" }, ac.signal);
  await tick();
  const g = "g1@g.us";
  // Ujjwal says "yes" in the group: must NOT count as the approval, must be queued for the agent.
  await bridge.handle({ ...msg(g, "[Message from Ujjwal]\nyes"), fromMe: false });
  await tick();
  assert.ok(wa.texts(g).some((t) => /Queued/.test(t)));
  let settled = false;
  void approval.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  // the owner answers -> resolves
  await bridge.handle(msg(g, "yes"));
  assert.deepEqual(await approval, { kind: "once" });
  d.resolve(ok("deleted"));
  await tick();
  const ran = agents.filter((a) => a.runs.length);
  assert.deepEqual(ran[0].runs, ["delete the stale pod", "[Message from Ujjwal]\nyes"]);
  FakeAgent.pending.shift()!.resolve(ok("noted"));
});

test("/here runs inline in the self-chat; /tasks lists; /cancel <id> targets a task", async () => {
  const { wa, bridge, agents } = setup();
  await bridge.handle(msg(SELF, "/here what time is it"));
  await tick();
  assert.equal(wa.groups.length, 0);
  assert.equal(agents[0].runs[0], "what time is it");
  FakeAgent.pending.shift()!.resolve(ok("16:40 IST"));
  await tick();
  assert.ok(wa.texts(SELF).some((t) => t.includes("16:40 IST")));
  await bridge.handle(msg(SELF, "long task"));
  await tick();
  await bridge.handle(msg(SELF, "/tasks"));
  await tick();
  assert.ok(wa.texts(SELF).some((t) => /🏃 #1 long task · running/.test(t)));
  await bridge.handle(msg(SELF, "/cancel 1"));
  await tick();
  assert.ok(wa.texts(SELF).some((t) => /Sent cancel to task #1/.test(t)));
  FakeAgent.pending.shift()!.resolve({ ...ok(""), ok: false });
});

test("/rename in a task group changes the title and the group subject; a title edited on disk is applied on start", async () => {
  const { wa, bridge, storeFile } = setup();
  await bridge.handle(msg(SELF, "help bipasha with her job search"));
  await tick();
  FakeAgent.pending.shift()!.resolve(ok("done"));
  await tick();
  assert.equal(wa.groups[0].subject, "✅ #1 · help bipasha with her job search");
  await bridge.handle(msg("g1@g.us", "/rename Bipasha BA Job Hunt"));
  assert.equal(bridge.tasks[0].title, "Bipasha BA Job Hunt");
  assert.equal(wa.groups[0].subject, "✅ #1 · Bipasha BA Job Hunt");
  assert.ok(wa.texts("g1@g.us").some((t) => /Group renamed to \*✅ #1 · Bipasha BA Job Hunt\*/.test(t)));
  // a member's /rename is treated as an instruction, not a command
  await bridge.handle({ ...msg("g1@g.us", "[Message from Ujjwal]\n/rename hijack"), fromMe: false });
  await tick();
  assert.equal(bridge.tasks[0].title, "Bipasha BA Job Hunt");
  FakeAgent.pending.shift()?.resolve(ok("ok"));
  await tick();
  // title edited in tasks.json while the service was down → applied by syncSubjects on start
  const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  data.tasks["g1@g.us"].title = "Bipasha · BA job hunt";
  fs.writeFileSync(storeFile, JSON.stringify(data));
  const bridge2 = new Bridge(wa, { storeFile, agentFactory: (init) => new FakeAgent(init.onSessionChange, init.sessionId) });
  await bridge2.syncSubjects();
  assert.equal(wa.groups[0].subject, "✅ #1 · Bipasha · BA job hunt");
  assert.equal(JSON.parse(fs.readFileSync(storeFile, "utf8")).tasks["g1@g.us"].appliedSubject, "✅ #1 · Bipasha · BA job hunt");
});

test("files the agent leaves in outbox/<task id>/ are sent to the group after the run, or on start after a restart", async () => {
  const { wa, bridge, agents, storeFile } = setup();
  await bridge.handle(msg(SELF, "make me a pdf"));
  await tick();
  const outbox = path.join(config.workspace, "outbox", "1");
  const groupAgent = agents.find((a) => a.runs.length)!;
  assert.equal(groupAgent.lastOpts?.outboxDir, outbox, "agent is told where the outbox is");
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, "report.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(outbox, ".DS_Store"), "");
  FakeAgent.pending.shift()!.resolve(ok("here is your pdf"));
  await tick();
  assert.deepEqual(wa.files.map((f) => [f.jid, path.basename(f.file)]), [["g1@g.us", "report.pdf"]]);
  assert.ok(fs.existsSync(path.join(outbox, "sent", "report.pdf")), "moved to sent/");
  assert.ok(!fs.existsSync(path.join(outbox, "report.pdf")));
  // a member's read-only run gets no outbox
  await bridge.handle({ ...msg("g1@g.us", "[Message from Ujjwal]\nand a csv?"), fromMe: false });
  await tick();
  assert.equal(groupAgent.lastOpts?.outboxDir, undefined);
  FakeAgent.pending.shift()!.resolve(ok("no"));
  await tick();
  // produced just before a restart → delivered by onConnected() of the new process
  fs.writeFileSync(path.join(outbox, "late.xlsx"), "x");
  const bridge2 = new Bridge(wa, { storeFile, agentFactory: (init) => new FakeAgent(init.onSessionChange, init.sessionId) });
  await bridge2.onConnected();
  assert.deepEqual(wa.files.map((f) => path.basename(f.file)), ["report.pdf", "late.xlsx"]);
  assert.ok(fs.existsSync(path.join(outbox, "sent", "late.xlsx")));
});

test("task records survive a restart and a message in an old group resumes its session", async () => {
  const { wa, bridge, storeFile } = setup();
  await bridge.handle(msg(SELF, "first task"));
  await tick();
  FakeAgent.pending.shift()!.resolve(ok("done"));
  await tick();
  const sid = bridge.tasks[0].sessionId;
  // new Bridge over the same store file (simulated restart)
  const agents2: FakeAgent[] = [];
  const bridge2 = new Bridge(wa, { storeFile, agentFactory: (init) => { const a = new FakeAgent(init.onSessionChange, init.sessionId); agents2.push(a); return a; } });
  assert.ok(bridge2.isTaskGroup("g1@g.us"));
  await bridge2.handle(msg("g1@g.us", "and now?"));
  await tick();
  assert.equal(agents2[0].sessionId, sid, "resumed with the stored session id");
  FakeAgent.pending.shift()!.resolve(ok("ok"));
});

test("the instruction message is reacted ⏳ on pickup and ✅/⚠️ when the run ends", async () => {
  const { wa, bridge } = setup();
  const m1 = msg(SELF, "first");
  await bridge.handle(m1);
  await tick();
  assert.deepEqual(wa.reactions, [{ id: m1.id, emoji: "⏳" }]);
  FakeAgent.pending.shift()!.resolve(ok("done"));
  await tick();
  assert.deepEqual(wa.reactions.at(-1), { id: m1.id, emoji: "✅" });
  // a follow-up in the group: ⏳ then ⚠️ on failure
  const m2 = msg("g1@g.us", "and now");
  await bridge.handle(m2);
  await tick();
  assert.deepEqual(wa.reactions.at(-1), { id: m2.id, emoji: "⏳" });
  FakeAgent.pending.shift()!.resolve({ ...ok("boom"), ok: false });
  await tick();
  assert.deepEqual(wa.reactions.at(-1), { id: m2.id, emoji: "⚠️" });
});

test("heartbeat posts a 'still working' note when the chat has been quiet", async () => {
  const { wa, bridge } = setup();
  const prev = config.heartbeatSec;
  config.heartbeatSec = 0.1; // tick every 25 ms, note after 100 ms of silence
  try {
    await bridge.handle(msg(SELF, "/here slow task"));
    await tick();
    assert.ok(!wa.texts(SELF).some((t) => /Still working/.test(t)), "no note right away");
    await new Promise((r) => setTimeout(r, 200));
    const notes = wa.texts(SELF).filter((t) => /Still working/.test(t));
    assert.ok(notes.length >= 1, "note after silence");
    FakeAgent.pending.shift()!.resolve(ok("finished"));
    await tick();
    const after = wa.texts(SELF).filter((t) => /Still working/.test(t)).length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(wa.texts(SELF).filter((t) => /Still working/.test(t)).length, after, "stops after the run");
  } finally {
    config.heartbeatSec = prev;
  }
});

test("makeTitle", () => {
  assert.equal(makeTitle("check why pda-backend build 464 failed on jenkins and fix it"), "check why pda-backend build 464 failed");
  assert.equal(makeTitle("hi"), "hi");
  assert.equal(makeTitle("do this\n[Attachment saved at: /x/y.pdf]"), "do this");
});

test("a group member's instruction runs in read-only mode; the owner's does not", async () => {
  const { bridge, agents } = setup();
  await bridge.handle(msg(SELF, "owner task"));
  await tick();
  const g = "g1@g.us";
  FakeAgent.pending.shift()!.resolve(ok("done"));
  await tick();
  await bridge.handle({ ...msg(g, "[Message from Ujjwal]\nwhy is the pod crashlooping?"), fromMe: false });
  await tick();
  const a = agents.filter((x) => x.runs.length)[0];
  assert.equal(a.runs[1], "[Message from Ujjwal]\nwhy is the pod crashlooping?");
  assert.deepEqual(a.lastOpts, { readOnly: true, requester: "Ujjwal" });
  FakeAgent.pending.shift()!.resolve(ok("because …"));
  await tick();
  await bridge.handle(msg(g, "fix it"));
  await tick();
  assert.equal(a.lastOpts?.readOnly, undefined);
  FakeAgent.pending.shift()!.resolve(ok("fixed"));
});
