// Router between WhatsApp chats and conversations.
//
// - The self-chat is the launcher: every instruction typed there becomes a
//   task with its own WhatsApp group ("#7 · short title"), its own Claude
//   session, and its own feed/approvals/result. Up to `maxParallel` tasks run
//   at once; the rest wait for a slot.
// - Messages typed inside a task group go to that task (answers to prompts,
//   follow-up instructions in the same session, /cancel, /status …).
// - "/here <instruction>" runs inline in the self-chat (the old sequential mode).
import fs from "node:fs";
import path from "node:path";
import { Agent } from "./agent.ts";
import { config } from "./config.ts";
import { Conversation, HELP, Semaphore, type AgentLike, type Sender } from "./conversation.ts";
import { truncate } from "./format.ts";
import type { InboundMessage } from "./whatsapp.ts";

export interface Transport extends Sender {
  readonly selfChatJid: string | undefined;
  createGroup(subject: string): Promise<string>;
  renameGroup(jid: string, subject: string): Promise<void>;
}

export type TaskStatus = "queued" | "running" | "done" | "failed";
export type TaskRecord = {
  id: number;
  title: string;
  groupJid: string;
  instruction: string;
  sessionId?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

class TaskStore {
  data: { nextId: number; tasks: Record<string, TaskRecord> } = { nextId: 1, tasks: {} };
  private file: string;
  constructor(file: string) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* fresh */ }
  }
  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { console.error("task store save failed", e); }
  }
}

const LAUNCHER_HELP = `This is the launcher chat. Anything you type here starts a *new task in its own group* (up to ${config.maxParallel} run at once); open that group for the live feed, approvals and result. Follow-ups typed in a task's group continue that task.

/tasks – list recent tasks
/cancel <id> – stop task #id
/here <instruction> – run inline here instead of in a group

${HELP}`;

export type BridgeOptions = {
  /** Build the agent for a conversation (tests inject a fake). */
  agentFactory?: (init: { sessionId?: string; onSessionChange: (id: string) => void }) => AgentLike;
  storeFile?: string;
};

export class Bridge {
  private wa: Transport;
  private gate = new Semaphore(config.maxParallel);
  private store: TaskStore;
  private convs = new Map<string, Conversation>();
  private selfConv: Conversation | null = null;
  private heldSelfAttachments: string[] = [];
  private agentFactory: NonNullable<BridgeOptions["agentFactory"]>;

  constructor(wa: Transport, opts: BridgeOptions = {}) {
    this.wa = wa;
    this.store = new TaskStore(opts.storeFile ?? path.join(config.stateDir, "tasks.json"));
    this.agentFactory = opts.agentFactory ?? ((init) => new Agent(init));
  }

  /** Used by the transport to accept messages from our own task groups. */
  isTaskGroup(jid: string): boolean { return jid in this.store.data.tasks; }

  get tasks(): TaskRecord[] { return Object.values(this.store.data.tasks).sort((a, b) => b.id - a.id); }

  async handle(m: InboundMessage): Promise<void> {
    if (this.isTaskGroup(m.chatJid)) {
      await this.groupConversation(m.chatJid).handle(m);
      return;
    }
    // self-chat (or an allowed extra sender): launcher
    const text = m.text.trim();
    if (m.attachments.length && !text) {
      this.heldSelfAttachments.push(...m.attachments);
      await this.self(m.chatJid).say(`📎 Saved ${m.attachments.map((a) => path.basename(a)).join(", ")}. Tell me what to do with it.`);
      return;
    }
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd.toLowerCase()) {
        case "help": return this.self(m.chatJid).say(LAUNCHER_HELP);
        case "tasks": return this.listTasks(m.chatJid);
        case "cancel": {
          if (/^\d+$/.test(arg)) return this.cancelTask(m.chatJid, Number(arg));
          return this.self(m.chatJid).handle(m);
        }
        case "here": {
          if (!arg) return this.self(m.chatJid).say("Usage: /here <instruction>");
          return this.self(m.chatJid).handle({ ...m, text: arg + this.takeHeldSelf() });
        }
        default: return this.self(m.chatJid).handle(m);
      }
    }
    if (!config.taskGroups || this.self(m.chatJid).waitingForUser) {
      return this.self(m.chatJid).handle({ ...m, text: text + this.takeHeldSelf() });
    }
    await this.startTask(m.chatJid, text + this.takeHeldSelf(), m);
  }

  private takeHeldSelf(): string {
    const files = this.heldSelfAttachments;
    this.heldSelfAttachments = [];
    return files.length ? "\n" + files.map((f) => `[Attachment saved at: ${f}]`).join("\n") : "";
  }

  private self(jid: string): Conversation {
    if (!this.selfConv || this.selfConv.jid !== jid) {
      const agent = this.agentFactory({ sessionId: undefined, onSessionChange: () => {} });
      this.selfConv = new Conversation(jid, this.wa, agent, this.gate);
    }
    return this.selfConv;
  }

  private groupConversation(groupJid: string): Conversation {
    let conv = this.convs.get(groupJid);
    if (conv) return conv;
    const rec = this.store.data.tasks[groupJid];
    const agent = this.agentFactory({
      sessionId: rec.sessionId,
      onSessionChange: (id) => { rec.sessionId = id; rec.updatedAt = new Date().toISOString(); this.store.save(); },
    });
    conv = new Conversation(groupJid, this.wa, agent, this.gate, {
      onStart: () => this.setStatus(rec, "running"),
      onFinish: (r) => this.setStatus(rec, r.ok ? "done" : "failed"),
    });
    this.convs.set(groupJid, conv);
    return conv;
  }

  private async startTask(launcherJid: string, instruction: string, m: InboundMessage): Promise<void> {
    const id = this.store.data.nextId++;
    const title = makeTitle(instruction);
    const subject = `#${id} · ${title}`;
    let groupJid: string;
    try {
      groupJid = await this.wa.createGroup(subject);
    } catch (e) {
      this.store.data.nextId--;
      await this.self(launcherJid).say(`⚠️ Could not create a group (${(e as Error).message}); running here instead.`);
      return this.self(launcherJid).handle({ ...m, text: instruction });
    }
    const now = new Date().toISOString();
    const rec: TaskRecord = { id, title, groupJid, instruction, status: "queued", createdAt: now, updatedAt: now };
    this.store.data.tasks[groupJid] = rec;
    this.store.save();
    const slotNote = this.gate.running >= this.gate.limit ? ` It waits for a free slot (${this.gate.running} running).` : "";
    await this.self(launcherJid).say(`🧵 Task #${id} started → open the group *${subject}* for the live feed and approvals.${slotNote}`);
    const conv = this.groupConversation(groupJid);
    await conv.say(`🧵 *Task #${id}*\n${truncate(instruction, 1500)}\n\nReply here to answer prompts or add follow-ups. /cancel stops it.`);
    // The launcher message gets ⏳ now and ✅/⚠️ when the task ends, so the
    // self-chat doubles as a task board even without opening the group.
    conv.submit(instruction, {}, m.key);
  }

  private setStatus(rec: TaskRecord, status: TaskStatus): void {
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
    this.store.save();
    if (status === "done" || status === "failed") {
      const mark = status === "done" ? "✅" : "⚠️";
      void this.wa.renameGroup(rec.groupJid, `${mark} #${rec.id} · ${rec.title}`).catch((e) => console.error("rename failed", (e as Error).message));
    }
  }

  private async listTasks(jid: string): Promise<void> {
    const rows = this.tasks.slice(0, 12).map((t) => {
      const icon = { queued: "⏳", running: "🏃", done: "✅", failed: "⚠️" }[t.status];
      const age = Math.round((Date.now() - Date.parse(t.updatedAt)) / 60000);
      return `${icon} #${t.id} ${t.title} · ${t.status} ${age}m ago`;
    });
    const head = `${this.gate.running}/${this.gate.limit} running, ${this.gate.waiting} waiting for a slot.`;
    await this.self(jid).say(rows.length ? `${head}\n${rows.join("\n")}` : `${head}\nNo tasks yet.`);
  }

  private async cancelTask(jid: string, id: number): Promise<void> {
    const rec = this.tasks.find((t) => t.id === id);
    if (!rec) return this.self(jid).say(`No task #${id}.`);
    const conv = this.convs.get(rec.groupJid);
    if (!conv || !conv.busy) return this.self(jid).say(`Task #${id} is not running.`);
    await conv.cancel();
    await this.self(jid).say(`🛑 Sent cancel to task #${id}.`);
  }
}

/** "check why pda-backend build 464 failed on jenkins and …" -> "check why pda-backend build 464 failed" */
export function makeTitle(instruction: string): string {
  const firstLine = instruction.split("\n")[0].replace(/\[Attachment saved at:[^\]]*\]/g, "").trim();
  const words = firstLine.split(/\s+/).filter(Boolean);
  let title = "";
  for (const w of words) {
    if ((title + " " + w).trim().length > 40) break;
    title = (title + " " + w).trim();
  }
  return title || firstLine.slice(0, 40) || "task";
}
