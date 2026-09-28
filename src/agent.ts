// Runs instructions through the Claude Agent SDK (the Claude Code engine,
// headless) with a persistent session, and relays approvals / questions to
// whoever is on the other end of the chat via the Prompter interface.
import fs from "node:fs";
import path from "node:path";
import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";
import { classify, readOnlyViolation } from "./policy.ts";

/** Per-run options. `readOnly` is used for requests from other group members; `outboxDir` is where files for the chat go. */
export type RunOptions = { readOnly?: boolean; requester?: string; outboxDir?: string };

const OUTBOX_APPEND = (dir: string) => `
- Sending files to the chat: copy any file the user should receive (PDF, image, spreadsheet, document …) into ${dir}/ and mention it in your reply. Everything left there is delivered into the chat as an attachment right after your reply; never paste file contents as text instead.`;

const READ_ONLY_APPEND = (who: string) => `
READ-ONLY MODE. This request comes from ${who}, a member of the task group, not from the owner.
- You may only look things up and answer. Every write, apply, delete, push, mail, ticket update, or file change is blocked by the harness and must not be attempted, including files in your workspace.
- If the request needs a change, answer what you can and say the owner has to ask for the change.
- You cannot ask questions in this mode; state your assumptions instead.
- Address ${who} by name and keep it brief.`;

export type Question = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
};

export type ApprovalRequest = {
  toolName: string;
  summary: string;
  detail: string;
  canAlways: boolean;
  /** Claude's own one-line justification (the tool call's `description`). */
  why?: string;
  /** What Claude said just before making the call (its narration). */
  context?: string;
};
export type ApprovalAnswer = { kind: "once" } | { kind: "always" } | { kind: "deny"; message: string };

export interface Prompter {
  askApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
  askQuestions(questions: Question[], signal: AbortSignal): Promise<Record<string, string>>;
  /** Claude's narration between tool calls. */
  progress(text: string): void;
  /** One line per tool call / tool result, mirroring what the terminal shows. */
  activity(line: string): void;
}

export type RunResult = {
  text: string;
  ok: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
};

const SYSTEM_APPEND = `
You are being driven from a WhatsApp chat on the user's phone; the user is not at a terminal.
- Replies are read on a phone: keep them short, plain text, no tables, no headers, at most a few bullets. Use *bold* sparingly.
- Do the work end to end. When an instruction is ambiguous in a way that changes the outcome, ask with the AskUserQuestion tool (the user answers in chat) instead of guessing.
- You may make changes (apply, scale, push, commit, write files, send mail, create/update tickets) without asking. Only destructive or delete actions (rm, kubectl delete, helm uninstall, aws delete/terminate, terraform destroy, force-push, branch/tag deletion, dropping data, deleting mail/records) trigger an approval prompt the user answers in chat. Batch related deletions so the user is not asked ten times.
- Before any destructive/delete call: (1) in your text, state in one or two sentences why it is needed, what exactly is affected, and what happens if it is skipped; (2) put the same justification in the tool call's "description" field. Both are shown to the user with the approval prompt; a prompt without a reason will be declined.
- The user sees a live feed of every tool call you make, so keep tool "description" fields meaningful.
- When you finish, summarise what you did, what you verified, and anything left open, in a form that stands alone in a chat.
`;

export class Agent {
  private sessionFile = path.join(config.stateDir, "session.json");
  private auditFile = path.join(config.stateDir, "audit.log");
  sessionId: string | undefined;
  private abort: AbortController | null = null;
  private currentQuery: ReturnType<typeof query> | null = null;
  running = false;
  startedAt = 0;

  private onSessionChange: ((id: string) => void) | null = null;

  /**
   * Without options the session id is persisted in state/session.json (the
   * self-chat). With options the owner supplies the initial id and receives
   * changes (one agent per task group).
   */
  constructor(opts?: { sessionId?: string; onSessionChange: (id: string) => void }) {
    fs.mkdirSync(config.stateDir, { recursive: true });
    if (opts) {
      this.sessionId = opts.sessionId;
      this.onSessionChange = opts.onSessionChange;
      return;
    }
    try {
      const s = JSON.parse(fs.readFileSync(this.sessionFile, "utf8"));
      if (typeof s.sessionId === "string") this.sessionId = s.sessionId;
    } catch { /* fresh */ }
  }

  private saveSession(): void {
    if (this.onSessionChange) { if (this.sessionId) this.onSessionChange(this.sessionId); return; }
    fs.writeFileSync(this.sessionFile, JSON.stringify({ sessionId: this.sessionId, savedAt: new Date().toISOString() }, null, 2));
  }

  newSession(): void {
    this.sessionId = undefined;
    this.saveSession();
  }

  private audit(entry: Record<string, unknown>): void {
    try { fs.appendFileSync(this.auditFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n"); } catch { /* ignore */ }
  }

  async cancel(): Promise<boolean> {
    if (!this.running) return false;
    try { await this.currentQuery?.interrupt(); } catch { /* fall through */ }
    this.abort?.abort();
    return true;
  }

  async run(instruction: string, prompter: Prompter, runOpts: RunOptions = {}): Promise<RunResult> {
    if (this.running) throw new Error("agent already running");
    const readOnly = runOpts.readOnly === true;
    const requester = runOpts.requester || "a group member";
    this.running = true;
    this.startedAt = Date.now();
    const abort = new AbortController();
    this.abort = abort;
    const t0 = Date.now();
    let lastText = "";
    let resultText = "";
    let ok = false;
    let turns = 0;
    let cost = 0;

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
    ): Promise<PermissionResult> => {
      if (readOnly) {
        const v = readOnlyViolation(toolName, input);
        if (v) {
          this.audit({ kind: "readonly-deny", toolName, reason: v, requester, input: brief(input) });
          return { behavior: "deny", message: `Read-only mode (request from ${requester}): ${v} is not allowed. Answer with what you can read; the owner must ask for changes.` };
        }
      }
      if (toolName === "AskUserQuestion") {
        const questions = (input.questions as Question[]) ?? [];
        const answers = await prompter.askQuestions(questions, opts.signal);
        this.audit({ kind: "question", questions: questions.map((q) => q.question), answers });
        return { behavior: "allow", updatedInput: { ...input, questions, answers } };
      }
      const decision = classify(toolName, input, config.workspace);
      if (decision.kind === "allow") {
        this.audit({ kind: "auto-allow", toolName, reason: decision.reason, input: brief(input) });
        return { behavior: "allow", updatedInput: input };
      }
      const answer = await prompter.askApproval(
        {
          toolName,
          summary: decision.summary,
          detail: decision.detail,
          canAlways: (opts.suggestions?.length ?? 0) > 0,
          why: typeof input.description === "string" ? input.description : undefined,
          context: lastText || undefined,
        },
        opts.signal,
      );
      this.audit({ kind: "approval", toolName, summary: decision.summary, answer: answer.kind, input: brief(input) });
      if (answer.kind === "once") return { behavior: "allow", updatedInput: input };
      if (answer.kind === "always") {
        return { behavior: "allow", updatedInput: input, updatedPermissions: opts.suggestions ?? [] };
      }
      return { behavior: "deny", message: answer.message };
    };

    const q = query({
      prompt: instruction,
      options: {
        cwd: config.workspace,
        resume: this.sessionId,
        permissionMode: "default",
        canUseTool,
        abortController: abort,
        maxTurns: config.maxTurns,
        ...(config.model ? { model: config.model } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND + (runOpts.outboxDir && !readOnly ? OUTBOX_APPEND(runOpts.outboxDir) : "") + (readOnly ? READ_ONLY_APPEND(requester) : "") },
        additionalDirectories: [path.dirname(config.root)],
        ...(readOnly
          ? {
              disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "AskUserQuestion"],
              // Hooks run before allow rules and permission modes, so this blocks
              // writes even where settings would otherwise auto-approve them.
              hooks: {
                PreToolUse: [{
                  hooks: [async (hookInput) => {
                    const h = hookInput as { tool_name?: string; tool_input?: unknown };
                    const v = readOnlyViolation(h.tool_name ?? "", (h.tool_input ?? {}) as Record<string, unknown>);
                    if (!v) return {};
                    this.audit({ kind: "readonly-hook-deny", toolName: h.tool_name, reason: v, requester });
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse" as const,
                        permissionDecision: "deny" as const,
                        permissionDecisionReason: `Read-only mode (request from ${requester}): ${v} is not allowed.`,
                      },
                    };
                  }],
                }],
              },
            }
          : {}),
      },
    });
    this.currentQuery = q;

    // tool_use id -> display name, so tool results can be attributed
    const toolsInFlight = new Map<string, string>();
    const sub = (m: { parent_tool_use_id: string | null }) => (m.parent_tool_use_id ? "  " : "");

    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === "system" && m.subtype === "init") {
          if (m.session_id && m.session_id !== this.sessionId) {
            this.sessionId = m.session_id;
            this.saveSession();
          }
          continue;
        }
        if (m.type === "assistant") {
          for (const block of m.message.content) {
            if (block.type === "text" && block.text.trim()) {
              lastText = block.text.trim();
              if (config.progressUpdates) prompter.progress(lastText);
            } else if (block.type === "tool_use") {
              const input = (block.input ?? {}) as Record<string, unknown>;
              toolsInFlight.set(block.id, block.name);
              if (config.verboseTools) prompter.activity(`${sub(m)}🔧 ${describeToolCall(block.name, input)}`);
            }
          }
          continue;
        }
        if (m.type === "user" && config.verboseTools && Array.isArray(m.message.content)) {
          for (const block of m.message.content) {
            if (block.type !== "tool_result") continue;
            const name = toolsInFlight.get(block.tool_use_id);
            if (!name) continue; // not from this run (replayed history)
            toolsInFlight.delete(block.tool_use_id);
            prompter.activity(`${sub(m)}   ↳ ${summarizeToolResult(name, block.content, block.is_error === true)}`);
          }
          continue;
        }
        if (m.type === "result") {
          turns = m.num_turns;
          cost = m.total_cost_usd ?? 0;
          if (m.subtype === "success") {
            ok = !m.is_error;
            resultText = m.result ?? "";
          } else {
            ok = false;
            const errs = "errors" in m && Array.isArray(m.errors) ? m.errors.join("; ") : "";
            resultText = `Stopped: ${m.subtype}${errs ? ` (${errs})` : ""}`;
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (abort.signal.aborted) resultText = resultText || "Cancelled.";
      else resultText = resultText || `Agent error: ${msg}`;
      ok = false;
    } finally {
      this.running = false;
      this.currentQuery = null;
      this.abort = null;
    }

    // Avoid sending the same final text twice when progress updates are on.
    if (config.progressUpdates && resultText.trim() === lastText) resultText = "";
    return { text: resultText, ok, turns, costUsd: cost, durationMs: Date.now() - t0, sessionId: this.sessionId };
  }
}

function brief(input: Record<string, unknown>): string {
  if (!input) return "";
  if (typeof input.command === "string") return input.command.slice(0, 200);
  if (typeof input.file_path === "string") return String(input.file_path);
  return JSON.stringify(input).slice(0, 200);
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** "Bash · Check running pods · kubectl get pods -n niq" — what the terminal would show for a tool call. */
function describeToolCall(name: string, input: Record<string, unknown>): string {
  const desc = typeof input.description === "string" ? oneLine(input.description, 90) : "";
  let arg = "";
  switch (name) {
    case "Bash": arg = oneLine(String(input.command ?? ""), 160); break;
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
      arg = String(input.file_path ?? input.notebook_path ?? ""); break;
    case "Glob": case "Grep": arg = oneLine(`${input.pattern ?? ""} ${input.path ?? ""}`, 120); break;
    case "WebFetch": arg = String(input.url ?? ""); break;
    case "WebSearch": arg = String(input.query ?? ""); break;
    case "Task": case "Agent": arg = oneLine(String(input.description ?? input.prompt ?? ""), 120); break;
    case "AskUserQuestion": arg = "asking you"; break;
    case "ToolSearch": arg = String(input.query ?? ""); break;
    case "Skill": arg = String(input.skill ?? ""); break;
    default: arg = oneLine(JSON.stringify(input), 140);
  }
  const shortName = name.startsWith("mcp__") ? name.split("__").slice(1).join(" › ") : name;
  return [shortName, desc, arg].filter(Boolean).join(" · ");
}

/** First useful line of a tool result, with an error marker. */
function summarizeToolResult(name: string, content: unknown, isError: boolean): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
  if (isError) return `❌ ${oneLine(first || "error", 160)}${more}`;
  if (!first) return "done";
  if (name === "Read" || name === "Glob" || name === "Grep") return `${lines.length} lines`;
  return `${oneLine(first, 140)}${more}`;
}
