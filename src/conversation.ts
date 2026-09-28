// One chat thread (the self-chat or a task group): its own agent session,
// instruction queue, pending approval/question slot, and outgoing message
// pipeline. The Bridge routes inbound messages to the right Conversation.
import path from "node:path";
import type { ApprovalAnswer, ApprovalRequest, Prompter, Question, RunOptions, RunResult } from "./agent.ts";
import { config } from "./config.ts";
import { mdToWhatsApp, truncate } from "./format.ts";
import type { InboundMessage, MessageRef } from "./whatsapp.ts";

/** What a Conversation needs from the transport (WhatsApp, or a fake in tests). */
export interface Sender {
  send(jid: string, text: string): Promise<void>;
  setTyping(jid: string, on: boolean): Promise<void>;
  /** React to a message with an emoji ("" removes the reaction); the chat comes from the key. */
  react(key: MessageRef, emoji: string): Promise<void>;
}

/** What a Conversation needs from the agent (Agent, or a fake in tests). */
export interface AgentLike {
  run(instruction: string, prompter: Prompter, opts?: RunOptions): Promise<RunResult>;
  cancel(): Promise<boolean>;
  newSession(): void;
  readonly running: boolean;
  readonly startedAt: number;
  readonly sessionId: string | undefined;
}

/** Counting semaphore shared by all conversations: at most N agent runs at once. */
export class Semaphore {
  running = 0;
  readonly limit: number;
  private waiters: (() => void)[] = [];
  constructor(limit: number) { this.limit = limit; }
  get waiting(): number { return this.waiters.length; }
  async acquire(): Promise<() => void> {
    if (this.running >= this.limit) await new Promise<void>((res) => this.waiters.push(res));
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.waiters.shift()?.();
    };
  }
}

export type ConversationEvents = {
  /** A run is about to start (after a slot was acquired). */
  onStart?: (instruction: string) => void;
  /** A run finished. */
  onFinish?: (result: RunResult) => void;
  /** Unknown slash command; return true if handled. */
  onCommand?: (cmd: string, arg: string) => Promise<boolean>;
};

type Pending = { resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export const HELP = `Commands:
/help – this list
/status – what I'm doing right now
/cancel – stop the current task
/new – forget the conversation and start a fresh session
/queue – show queued instructions
/clearqueue – drop queued instructions
/verbose on|off – live feed of every tool call and result (default on)
/progress on|off – forward my narration between tool calls (default on)
/heartbeat <seconds>|off – "still working" note when the chat is quiet that long (default 60)

Anything else is an instruction. While a task runs, new messages queue up unless I asked you something, in which case your next message is the answer.
Your message gets ⏳ when I pick it up and ✅ (or ⚠️) when the reply is complete; the reply itself ends with a "done · N turns · Ns" line.
Approvals: reply *yes* / *no* / *always*, or tell me what to do instead.
Files: send a document/photo with a caption and I get both. Without a caption I save it and attach it to your next message.`;

export class Conversation {
  private pending: Pending | null = null;
  private queue: { text: string; opts: RunOptions; ref?: MessageRef }[] = [];
  private heldAttachments: string[] = [];
  private approvalCounter = 0;
  private draining = false;
  readonly jid: string;
  readonly agent: AgentLike;
  private wa: Sender;
  private gate: Semaphore;
  private events: ConversationEvents;

  constructor(jid: string, wa: Sender, agent: AgentLike, gate: Semaphore, events: ConversationEvents = {}) {
    this.jid = jid;
    this.wa = wa;
    this.agent = agent;
    this.gate = gate;
    this.events = events;
  }

  get busy(): boolean { return this.agent.running || this.draining || this.queue.length > 0; }
  get waitingForUser(): boolean { return this.pending !== null; }

  async handle(m: InboundMessage): Promise<void> {
    let text = m.text.trim();

    if (m.attachments.length && !text) {
      this.heldAttachments.push(...m.attachments);
      const names = m.attachments.map((a) => path.basename(a)).join(", ");
      await this.say(`📎 Saved ${names} to workspace/inbox/. Tell me what to do with it.`);
      return;
    }
    if (!text.startsWith("/")) {
      const files = [...this.heldAttachments, ...m.attachments];
      this.heldAttachments = [];
      if (files.length) text += "\n" + files.map((f) => `[Attachment saved at: ${f}]`).join("\n");
    }

    // Other group members can only hand the agent instructions: they never
    // answer a pending approval/question and cannot run /commands.
    if (m.fromMe === false) {
      // Read-only: they get answers, never changes (enforced in Agent via hook + canUseTool).
      const who = text.match(/^\[Message from ([^\]]+)\]/)?.[1] ?? "a group member";
      this.submit(text, { readOnly: true, requester: who }, m.key);
      return;
    }

    if (this.pending) {
      if (/^\/cancel$/i.test(text)) { await this.cancel(); return; }
      if (/^\/status$/i.test(text)) { await this.status(); return; }
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(text);
      return;
    }

    if (text.startsWith("/")) { await this.command(text); return; }
    this.submit(text, {}, m.key);
  }

  /**
   * Queue an instruction and start draining if idle. `ref` is the WhatsApp
   * message that carried it: it gets ⏳ when the run starts and ✅/⚠️ when it
   * ends, which is the one signal WhatsApp shows the owner about their own chat.
   */
  submit(instruction: string, opts: RunOptions = {}, ref?: MessageRef): void {
    this.queue.push({ text: instruction, opts, ref });
    if (this.agent.running || this.draining) {
      if (ref) void this.wa.react(ref, "🕒");
      void this.say(`⏳ Queued (${this.queue.length} waiting). Send /cancel to stop the current task.`);
      return;
    }
    void this.drain();
  }

  private async command(text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").toLowerCase();
    switch (cmd.toLowerCase()) {
      case "help": return this.say(HELP);
      case "status": return this.status();
      case "cancel": return this.cancel();
      case "new": {
        if (this.agent.running) return this.say("A task is running. /cancel it first, then /new.");
        this.agent.newSession();
        return this.say("🧹 Fresh session. Previous context forgotten.");
      }
      case "queue": return this.say(this.queue.length ? this.queue.map((q, i) => `${i + 1}. ${q.opts.readOnly ? "🔎 " : ""}${truncate(q.text, 120)}`).join("\n") : "Queue is empty.");
      case "clearqueue": { const n = this.queue.length; this.queue = []; return this.say(`Dropped ${n} queued instruction(s).`); }
      case "verbose": { config.verboseTools = arg !== "off"; return this.say(`Live tool feed ${config.verboseTools ? "on" : "off"}.`); }
      case "progress": { config.progressUpdates = arg !== "off"; return this.say(`Narration ${config.progressUpdates ? "on" : "off"}.`); }
      case "heartbeat": {
        if (arg === "off" || arg === "0") { config.heartbeatSec = 0; return this.say("Heartbeat off."); }
        const n = parseInt(arg, 10);
        if (!arg) return this.say(config.heartbeatSec > 0 ? `Heartbeat every ${config.heartbeatSec}s of silence.` : "Heartbeat off.");
        if (isNaN(n) || n < 10) return this.say("Usage: /heartbeat <seconds ≥ 10> | off");
        config.heartbeatSec = n;
        return this.say(`Heartbeat: "still working" note after ${n}s of silence.`);
      }
      case "session": return this.say(`Session: ${this.agent.sessionId ?? "(none yet)"}`);
      default: {
        if (this.events.onCommand && (await this.events.onCommand(cmd.toLowerCase(), rest.join(" ")))) return;
        return this.say(`Unknown command /${cmd}. ${HELP}`);
      }
    }
  }

  async status(): Promise<void> {
    if (this.agent.running) {
      const mins = Math.round((Date.now() - this.agent.startedAt) / 60000);
      const waiting = this.pending ? " Waiting for your answer." : "";
      return this.say(`🏃 Working for ${mins} min.${waiting} ${this.queue.length} queued.`);
    }
    return this.say(`💤 Idle. ${this.queue.length} queued. Session ${this.agent.sessionId ? "resumes" : "is fresh"}.`);
  }

  async cancel(): Promise<void> {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new Error("cancelled by user"));
    }
    const was = await this.agent.cancel();
    await this.say(was ? "🛑 Cancelling the current task." : "Nothing running.");
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        await this.runOne(item.text, item.opts, item.ref);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(instruction: string, opts: RunOptions = {}, ref?: MessageRef): Promise<void> {
    if (this.gate.running >= this.gate.limit) {
      await this.say(`⏳ Waiting for a free slot (${this.gate.running} task${this.gate.running === 1 ? "" : "s"} running, limit ${this.gate.limit}).`);
    }
    const release = await this.gate.acquire();
    if (ref) void this.wa.react(ref, "⏳");
    const stopLiveness = this.startLiveness();
    const prompter = this.makePrompter();
    let mark = "⚠️";
    try {
      this.events.onStart?.(instruction);
      const r = await this.agent.run(instruction, prompter, opts);
      const mode = opts.readOnly ? `🔎 read-only reply to ${opts.requester ?? "group member"} · ` : "";
      const footer = `${mode}${r.ok ? "✅ done" : "⚠️ stopped"} · ${r.turns} turns · ${Math.round(r.durationMs / 1000)}s`;
      const body = r.text ? mdToWhatsApp(r.text) : "";
      if (r.ok) mark = "✅";
      await this.say(body ? `${body}\n\n_${footer}_` : `_${footer}_`);
      this.events.onFinish?.(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.say(`❌ ${msg}`);
      this.events.onFinish?.({ text: msg, ok: false, turns: 0, costUsd: 0, durationMs: 0 });
    } finally {
      release();
      await stopLiveness();
      if (ref) void this.wa.react(ref, mark);
    }
  }

  /**
   * Liveness signals while a run is active:
   * - "typing…" for the other members of the chat, re-sent every 8 s because
   *   WhatsApp drops it after ~10 s (and it is never shown to the owner);
   * - a "⏳ still working" note for the owner when nothing has been posted for
   *   `config.heartbeatSec` seconds, so silence is not mistaken for a dead link.
   * Both pause while we are waiting for the user to answer a prompt.
   * Returns a function that stops them and clears the typing state.
   */
  private startLiveness(): () => Promise<void> {
    const startedAt = Date.now();
    void this.wa.setTyping(this.jid, true);
    const typing = setInterval(() => { void this.wa.setTyping(this.jid, !this.pending); }, 8_000).unref();
    const tickMs = Math.max(20, Math.min(10_000, (config.heartbeatSec || 60) * 250));
    const beat = setInterval(() => {
      if (config.heartbeatSec <= 0 || this.pending || this.activityBuffer.length) return;
      if (Date.now() - this.lastSentAt < config.heartbeatSec * 1000) return;
      const mins = Math.round((Date.now() - startedAt) / 60000);
      const since = this.lastActivity ? `\nLast step: ${truncate(this.lastActivity.replace(/^\s*🔧\s*/, ""), 140)}` : "";
      void this.say(`⏳ Still working… ${mins} min so far.${since}`);
    }, tickMs).unref();
    return async () => {
      clearInterval(typing);
      clearInterval(beat);
      await this.wa.setTyping(this.jid, false);
    };
  }

  private waitForReply(promptText: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) { this.pending = null; reject(new Error("timeout")); }
      }, config.approvalTimeoutMin * 60_000);
      const onAbort = () => {
        if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        resolve: (t) => { signal.removeEventListener("abort", onAbort); resolve(t); },
        reject: (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
        timer,
      };
      this.say(promptText).catch(reject);
    });
  }

  private makePrompter(): Prompter {
    return {
      askApproval: async (req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> => {
        const n = ++this.approvalCounter;
        const detail = req.detail.trim();
        const shown = detail && detail !== req.summary ? `\n\`\`\`\n${truncate(detail, 1000)}\n\`\`\`` : "";
        const why = req.why?.trim();
        const ctx = req.context?.trim();
        const reason = why
          ? `\n*Why:* ${truncate(why, 400)}`
          : "\n*Why:* (no reason given by Claude — ask before approving)";
        const context = ctx && ctx !== why ? `\n*Claude said:* ${truncate(mdToWhatsApp(ctx), 700)}` : "";
        const text = `🔐 *Approval #${n}* – ${req.toolName}\n${req.summary}${shown}${reason}${context}\n\nReply *yes* / *no*${req.canAlways ? " / *always*" : ""}, or tell me what to do instead.`;
        let reply: string;
        try { reply = await this.waitForReply(text, signal); }
        catch (e) { return { kind: "deny", message: `No approval received (${(e as Error).message}); the user did not approve this action.` }; }
        const r = reply.trim().toLowerCase();
        if (/^(y|yes|ok|okay|approve|allow|go|go ahead|do it|sure|yep|yup|👍|✅)$/.test(r)) return { kind: "once" };
        if (/^(always|a|always allow|allow always)$/.test(r)) return req.canAlways ? { kind: "always" } : { kind: "once" };
        if (/^(n|no|nope|deny|reject|stop|skip|👎|❌)$/.test(r)) return { kind: "deny", message: "The user declined this action." };
        return { kind: "deny", message: `The user declined this action and said: "${reply.trim()}". Follow that instead.` };
      },
      askQuestions: async (questions: Question[], signal: AbortSignal): Promise<Record<string, string>> => {
        const answers: Record<string, string> = {};
        for (const q of questions) {
          const opts = (q.options ?? []).map((o, i) => `${i + 1}. *${o.label}*${o.description ? ` – ${o.description}` : ""}`).join("\n");
          const hint = q.multiSelect ? "Reply with number(s) like 1,3 or type your own answer." : "Reply with a number or type your own answer.";
          const text = `❓ *${q.header ?? "Question"}*\n${q.question}\n\n${opts}\n\n${hint}`;
          let reply: string;
          try { reply = await this.waitForReply(text, signal); }
          catch (e) { answers[q.question] = `(no answer: ${(e as Error).message})`; continue; }
          answers[q.question] = parseChoice(reply, q);
        }
        return answers;
      },
      progress: (text: string) => { void this.say(`💬 ${mdToWhatsApp(text)}`); },
      activity: (line: string) => this.pushActivity(line),
    };
  }

  // ---- outgoing messages: serialised per chat, tool activity batched every ~2.5s ----
  private sendChain: Promise<void> = Promise.resolve();
  private activityBuffer: string[] = [];
  private activityTimer: NodeJS.Timeout | null = null;
  /** When we last posted anything to this chat (heartbeat baseline). */
  private lastSentAt = Date.now();
  /** Most recent tool-call line, quoted in heartbeat notes. */
  private lastActivity = "";

  private pushActivity(line: string): void {
    if (/🔧/.test(line)) this.lastActivity = line.trim();
    this.activityBuffer.push(line);
    if (this.activityBuffer.join("\n").length > config.maxMessageChars * 0.8) { void this.flushActivity(); return; }
    if (!this.activityTimer) this.activityTimer = setTimeout(() => void this.flushActivity(), 2500);
  }

  private flushActivity(): Promise<void> {
    if (this.activityTimer) { clearTimeout(this.activityTimer); this.activityTimer = null; }
    if (!this.activityBuffer.length) return Promise.resolve();
    const text = this.activityBuffer.join("\n");
    this.activityBuffer = [];
    return this.enqueue(text);
  }

  private enqueue(text: string): Promise<void> {
    const p = this.sendChain.then(async () => {
      try { await this.wa.send(this.jid, text); this.lastSentAt = Date.now(); }
      catch (e) { console.error("send failed:", (e as Error).message); }
    });
    this.sendChain = p;
    return p;
  }

  /** Send a message to this chat, after any pending activity lines so ordering matches what happened. */
  say(text: string): Promise<void> {
    void this.flushActivity();
    return this.enqueue(text);
  }
}

function parseChoice(reply: string, q: Question): string {
  const opts = q.options ?? [];
  const nums = reply.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && n >= 1 && n <= opts.length);
  if (nums.length && nums.length === reply.split(/[,\s]+/).filter(Boolean).length) {
    const labels = nums.map((n) => opts[n - 1].label);
    return q.multiSelect ? labels.join(", ") : labels[0];
  }
  const byLabel = opts.find((o) => o.label.toLowerCase() === reply.trim().toLowerCase());
  return byLabel ? byLabel.label : reply.trim();
}
