// Central configuration. Everything can be overridden via environment variables
// (see .env.example). Values are resolved once at startup.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  root: ROOT,
  /** Directory the agent works in (its CLAUDE.md lives here). */
  workspace: env("CLAUDE_OFFICE_WORKSPACE", path.join(ROOT, "workspace")),
  /** Runtime state: WhatsApp auth, session id, audit log. */
  stateDir: env("CLAUDE_OFFICE_STATE", path.join(ROOT, "state")),
  /** Extra WhatsApp JIDs (e.g. "919876543210@s.whatsapp.net") allowed to
   *  command the agent besides your own self-chat. Comma separated. */
  allowedSenders: env("CLAUDE_OFFICE_ALLOWED_SENDERS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Accept messages from other members of our task groups (people you add to
   *  a task's group). Their messages arrive tagged with the sender's name and
   *  are always treated as instructions: they cannot answer approval prompts
   *  or run /commands. */
  groupMembers: env("CLAUDE_OFFICE_GROUP_MEMBERS", "true") === "true",
  /** Phone number in international format without "+" to use pairing-code
   *  login instead of QR (optional). */
  pairingPhone: env("CLAUDE_OFFICE_PAIRING_PHONE", ""),
  /** Prefix put on every message the agent sends, so its own messages are
   *  never mistaken for your instructions. */
  botPrefix: env("CLAUDE_OFFICE_PREFIX", "🤖 "),
  /** Forward Claude's short progress notes between tool calls. */
  progressUpdates: env("CLAUDE_OFFICE_PROGRESS", "true") === "true",
  /** Send a one-line note for every tool call (noisy; for debugging). */
  verboseTools: env("CLAUDE_OFFICE_VERBOSE_TOOLS", "true") === "true",
  /** How long to wait for an approval / answer before denying (minutes). */
  approvalTimeoutMin: Number(env("CLAUDE_OFFICE_APPROVAL_TIMEOUT_MIN", "60")),
  /** Model override. Empty = whatever your Claude Code settings default to. */
  model: env("CLAUDE_OFFICE_MODEL", ""),
  /** Max agentic turns per instruction (safety valve). */
  maxTurns: Number(env("CLAUDE_OFFICE_MAX_TURNS", "300")),
  /** How many tasks may run at the same time (each in its own group). */
  maxParallel: Number(env("CLAUDE_OFFICE_MAX_PARALLEL", "3")),
  /** Start every instruction from the self-chat as its own task group.
   *  false = old behaviour (sequential, inline in the self-chat). */
  taskGroups: env("CLAUDE_OFFICE_TASK_GROUPS", "true") === "true",
  /** Max characters per WhatsApp message before splitting. */
  maxMessageChars: 3500,
  /** Largest attachment (document/image/video/audio) to download into
   *  `<workspace>/inbox/`; bigger ones are skipped with a note. */
  maxAttachmentBytes: Number(env("CLAUDE_OFFICE_MAX_ATTACHMENT_MB", "200")) * 1024 * 1024,
};
