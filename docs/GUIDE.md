# claude-office: how it works and how to use it

claude-office turns your own WhatsApp into a remote control for Claude Code
running on your laptop. You type an instruction on your phone; a small Node
service on the Mac hands it to the Claude Agent SDK (the same engine as the
`claude` CLI, under your existing claude.ai login); Claude does the work with
the laptop's real tools and credentials (kubectl, aws, git, ssh, connectors) and
reports back in the same chat. Anything destructive asks you first, in the chat.

This guide covers:

1. [Architecture](#1-architecture)
2. [Message flow, step by step](#2-message-flow-step-by-step)
3. [Setup](#3-setup)
4. [Daily use](#4-daily-use)
5. [Approvals and questions](#5-approvals-and-questions)
6. [Attachments](#6-attachments)
7. [Other people in a task group](#7-other-people-in-a-task-group)
8. [Configuration reference](#8-configuration-reference)
9. [Files on disk](#9-files-on-disk)
10. [Operations: service, logs, restart, re-link](#10-operations)
11. [Security model](#11-security-model)
12. [Troubleshooting](#12-troubleshooting)
13. [Development](#13-development)

---

## 1. Architecture

```
 your phone                      this Mac                                  the world
 ┌───────────┐   WhatsApp    ┌──────────────────────────────────────┐
 │ WhatsApp  │ ◄───────────► │ src/whatsapp.ts  (Baileys link)      │
 │  self-chat│               │      │ InboundMessage                │
 │  + task   │               │      ▼                               │
 │  groups   │               │ src/bridge.ts    (router / launcher) │
 └───────────┘               │      │ one Conversation per chat     │
                             │      ▼                               │
                             │ src/conversation.ts (queue, prompts, │
                             │      │            batched feed)      │
                             │      ▼                               │
                             │ src/agent.ts     (Claude Agent SDK   │   kubectl / aws /
                             │      │            query(), resume)   │──► git / ssh / curl /
                             │      ▼                               │   Jira, Confluence,
                             │ src/policy.ts    (allow vs ask,      │   Outlook, Teams …
                             │                   read-only rules)   │
                             └──────────────────────────────────────┘
```

Components:

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point. Connects WhatsApp, builds the Bridge, posts "Online" to your self-chat. |
| `src/whatsapp.ts` | WhatsApp link via Baileys (multi-device web protocol). Filters who may talk to the agent, downloads attachments, sends replies (split at 3500 chars, prefixed with 🤖), creates and renames task groups, reconnects with back-off. |
| `src/bridge.ts` | Router. The self-chat is the *launcher*: each instruction becomes a task with its own WhatsApp group and its own Claude session. Messages typed inside a task group go to that task. Keeps `state/tasks.json`. |
| `src/conversation.ts` | One chat thread: instruction queue, the pending approval/question slot, slash commands, and the outgoing message pipeline (tool activity batched every ~2.5 s, ordering preserved). |
| `src/agent.ts` | Runs an instruction through `query()` from `@anthropic-ai/claude-agent-sdk` with `resume` for session continuity. Implements `canUseTool`: relays approvals and questions to the chat, enforces read-only mode for colleagues, writes `state/audit.log`. |
| `src/policy.ts` | The rules: which shell commands and connector tools are destructive (ask) and which are read-only (allowed for colleagues). |
| `src/format.ts` | Markdown → WhatsApp formatting, message splitting, attachment file names. |
| `workspace/` | Claude's working directory. `CLAUDE.md` there is its standing instructions (copy from `CLAUDE.md.example`). |
| `bin/` | launchd install/uninstall scripts, smoke and end-to-end checks. |

Concurrency: a counting semaphore (`CLAUDE_OFFICE_MAX_PARALLEL`, default 3)
caps how many Claude runs execute at once across all chats. Extra tasks wait
for a slot and say so in their group.

---

## 2. Message flow, step by step

### 2.1 You send an instruction in your self-chat ("You" / message yourself)

1. **Baileys receives it** (`whatsapp.ts handleInbound`). Messages are dropped
   unless they pass the gate: in the self-chat only your own messages count
   (plus any JID in `CLAUDE_OFFICE_ALLOWED_SENDERS`); status updates, unknown
   groups, history replayed from before the service started, and the bot's
   own echoes (messages starting with the 🤖 prefix) are ignored.
2. **Bridge sees it is the launcher chat.** Slash commands (`/tasks`,
   `/cancel <id>`, `/here …`) are handled here. Anything else starts a task:
   - a WhatsApp group is created with only your account in it, named
     `#<id> · <first ~40 chars of the instruction>`;
   - a `TaskRecord` is saved to `state/tasks.json`;
   - you get `🧵 Task #<id> started → open the group …` in the self-chat;
   - the group gets the full instruction and the instruction is queued on
     that group's `Conversation`.
3. **Conversation.runOne** waits for a free slot, turns on the typing
   indicator, and calls `Agent.run(instruction, prompter)`.
4. **Agent.run** starts `query()` with:
   - `cwd = workspace/` (so `workspace/CLAUDE.md` is loaded as project
     instructions),
   - `resume = <session id>` if the task already has one (follow-ups keep
     context),
   - `permissionMode: "default"` plus a `canUseTool` callback (see §5),
   - a system-prompt append that tells Claude it is on a phone: short replies,
     do the work end to end, ask via AskUserQuestion when ambiguous, justify
     destructive calls in the tool `description`.
5. **While Claude works** the SDK streams messages. The agent forwards:
   - 💬 Claude's narration between tool calls (`/progress on|off`),
   - 🔧 one line per tool call: tool · Claude's description · command or path,
   - ↳ one line per tool result (first line, error marker, `+N lines`).
   Tool lines are buffered and sent as one message every ~2.5 s (or when the
   buffer nears the WhatsApp size limit).
6. **When Claude finishes**, the final text is converted from Markdown and
   posted with a footer: `✅ done · 14 turns · 92s` (or `⚠️ stopped`). The
   group is renamed `✅ #id · title` or `⚠️ #id · title`, so your chat list is
   a task board. The session id is stored in `tasks.json`.

### 2.2 You type inside a task group

The Bridge routes it to that task's Conversation:

- If Claude is **waiting for you** (an approval or question is pending), your
  message is the answer. `/cancel` and `/status` still work.
- Otherwise a `/command` is executed (see §4.3), and any other text is queued
  as a **follow-up instruction in the same session** (Claude remembers the
  earlier work). If a run is in progress you get `⏳ Queued (n waiting)`.

### 2.3 Sequential mode

`/here <instruction>` runs inline in the self-chat instead of a group, using
one long-lived session stored in `state/session.json`. Set
`CLAUDE_OFFICE_TASK_GROUPS=false` to make that the default.

---

## 3. Setup

Requirements: macOS, Node 24+, a claude.ai login already working in the
`claude` CLI on this Mac, and a WhatsApp account on your phone.

1. **Install dependencies**

   ```
   git clone https://github.com/spawan1998/claude-office.git
   cd claude-office
   npm install
   ```

2. **Create the agent's standing instructions**

   ```
   cp workspace/CLAUDE.md.example workspace/CLAUDE.md
   ```

   Edit it: your name, email, timezone, where your working files and git
   clones live, which connectors you have. This file is what makes the agent
   *yours*; it is git-ignored.

3. **Optional settings**

   ```
   cp .env.example .env
   ```

   Uncomment what you need (see §8). `.env` is git-ignored. The launchd
   installer copies its lines into the service definition.

4. **First run in a terminal** (the QR scan needs one)

   ```
   set -a; source .env; set +a      # only if you created .env
   npm start
   ```

   On the phone: WhatsApp › Linked devices › Link a device › scan the QR
   printed in the terminal. Prefer a pairing code? Set
   `CLAUDE_OFFICE_PAIRING_PHONE=<country code + number>` in `.env`; the code
   is printed instead of a QR and you use "Link with phone number instead".

5. **Check it works.** When the terminal prints `WhatsApp connected`, open the
   "You" chat on your phone. You get an "Online" message. Send `/help`, then
   something harmless such as `what kube contexts do I have?`. macOS may show
   a Keychain prompt the first time the SDK reads your claude.ai login: click
   **Always Allow**.

6. **Install as a background service** so it survives logout and crashes:

   ```
   ./bin/install-service.sh
   ```

   This writes `~/Library/LaunchAgents/com.pavan.claude-office.plist`
   (rename the label in the script if you like), starts it, and restarts it
   on crash. Logs go to `logs/out.log` and `logs/err.log`.

7. **Keep the laptop awake and online.** On mains power: System Settings ›
   Battery › Options › "Prevent automatic sleeping when the display is off",
   or run `caffeinate -d -i -m -s` (a LaunchAgent for that is a good idea).
   Lid closed still sleeps unless you disable that with `sudo pmset
   disablesleep 1`.

---

## 4. Daily use

### 4.1 Give it work

Type in the self-chat exactly as you would speak to a colleague:

- `why is pda-backend build 464 failing on jenkins?`
- `scale niq-rulesgenerator-backend to 0 in dev` (runs without asking)
- `draft a reply to the last mail about the GPU nodepool` (draft only; it
  will not send unless you say so)
- `check my calendar for tomorrow and list Jira tickets assigned to me`

Each becomes its own group. Open the group to watch, answer, or add to it.
Several tasks can run at once (default 3); the rest wait.

### 4.2 Reading the feed

| Prefix | Meaning |
| --- | --- |
| 💬 | Claude's narration (what it is about to do / found). |
| 🔧 | A tool call: `Bash · Check pods in niq · kubectl get pods -n niq`. |
| ↳ | The result of the call above, one line. `❌` marks an error. |
| ⏳ | Queued, or waiting for a free slot. |
| 🔐 | An approval request (see §5). |
| ❓ | A question from Claude (see §5). |
| 🔎 | A read-only reply to a colleague (see §7). |
| ✅ / ⚠️ | Task finished / stopped, with turn count and duration. |

`/verbose off` hides the 🔧/↳ lines, `/progress off` hides 💬.

### 4.3 Commands

In the **self-chat (launcher)**:

| Command | Effect |
| --- | --- |
| `/tasks` | Recent tasks with status, and how many slots are busy. |
| `/cancel <id>` | Stop task #id. |
| `/here <instruction>` | Run inline in the self-chat (sequential mode). |
| `/help` | Launcher help plus the common commands below. |

In **any chat** (self-chat or a task group):

| Command | Effect |
| --- | --- |
| `/status` | What Claude is doing right now, queue length, whether it is waiting for you. |
| `/cancel` | Interrupt the current run (and clear a pending prompt). |
| `/new` | Forget the session; the next instruction starts fresh. |
| `/queue`, `/clearqueue` | Show or drop queued instructions. |
| `/verbose on\|off` | Live tool feed. |
| `/progress on\|off` | Narration between tool calls. |
| `/session` | Print the current session id. |

### 4.4 Follow-ups

Typing in a finished task's group resumes that session: "now do the same for
prod", "what was the exact error?", "undo that". Because the session id is
persisted in `state/tasks.json`, this works even after the service restarts.

### 4.5 Journal

The agent is instructed (via `workspace/CLAUDE.md`) to append 2–4 lines to
`workspace/JOURNAL.md` after each non-trivial task and to read its tail when a
new instruction refers to earlier work. That file is your cross-task memory.

---

## 5. Approvals and questions

### 5.1 Policy: everything runs on its own except destroy/delete

`src/policy.ts` classifies every tool call before it runs (`canUseTool`).

**Auto-approved:** all reads, all file writes and edits, `kubectl
apply/scale/patch/rollout`, `helm upgrade/rollback`, `argocd app sync`, `git
commit/push/checkout -b`, `aws` create/update/stop, `terraform apply`, `ssh`,
`sudo`, scripts, `curl` POSTs, sending mail or Teams messages, creating or
updating Jira and Confluence content.

**Asked first (a yes/no in the chat):**

- files: `rm`, `rmdir`, `shred`, `dd`, `mkfs`, `find -delete`, `xargs rm`,
  `truncate`, inline `shutil.rmtree` / `fs.rm` in python/node one-liners
- kubernetes: `kubectl delete/drain`, `apply --prune`, `replace --force`,
  `helm uninstall`, `argocd app delete` / `sync --prune`
- cloud: `aws … delete-*/terminate-*/deregister-*/revoke-*`, `aws s3 rm/rb/mv`,
  `s3 sync --delete`, `gcloud … delete`, `az … delete/purge`
- terraform: `destroy`, `apply -destroy`, `state rm`, `workspace delete`
- git: `push --force/--delete`, `branch -D/-m`, `tag -d`, `reset --hard`,
  `clean`, `checkout -- .`, `restore`, `stash drop`, `rebase`, `remote remove`,
  `worktree remove/prune`
- docker: `rm/rmi/kill`, `* prune`, `compose down -v`
- packages/system: `brew/npm/pip uninstall`, `launchctl bootout`, `crontab -r`
- SQL: `DROP`, `DELETE FROM`, `TRUNCATE`
- connectors (MCP tools) whose name contains delete, remove, trash, purge,
  revoke (mail, calendar events, SharePoint items, docs)

Command substitution (`$(…)`, backticks) is inspected too, and `sudo`, `env`,
`nohup`, `time` wrappers are skipped so the real binary is checked.

### 5.2 What an approval looks like

```
🔐 Approval #3 – Bash
destructive: kubectl delete
kubectl delete pod niq-rulesgenerator-backend-7d9f-abcde -n niq
Why: Pod is stuck Terminating for 40 min after the node was drained; the
Deployment recreates it. Skipping leaves the stale pod blocking the rollout.
Claude said: The rollout is blocked by one stale pod on ip-10-1-3-7 …
Reply yes / no / always, or tell me what to do instead.
```

- **Why** is the tool call's own `description`. The agent is told that a
  prompt without a reason will be declined, so an empty *Why* is a red flag.
- **Claude said** is its last narration before the call, for context.
- Reply `yes` (`ok`, `go ahead`, 👍 …) to allow once, `always` to add the
  SDK's suggested rule for the rest of the session (offered only when the SDK
  has a suggestion), `no` to decline, or type anything else: the text is
  passed back to Claude as "the user declined and said: …", so "no, scale it
  to 0 instead" works.
- If you do not answer within `CLAUDE_OFFICE_APPROVAL_TIMEOUT_MIN` (default
  60) the action is denied and Claude continues without it.

The agent is instructed to finish its investigation first and batch related
deletions, so one approval covers one coherent change instead of ten prompts.

### 5.3 Questions

When an instruction is ambiguous Claude asks instead of guessing:

```
❓ Environment
Which cluster should I scale?
1. dev – hilabs-dev-eks
2. prod – hilabs-prod-eks
Reply with a number or type your own answer.
```

Reply with the number(s) (`1`, `1,3`), the option label, or free text.

### 5.4 Audit trail

Every decision is appended to `state/audit.log` as one JSON line:
`auto-allow`, `approval` (with your answer), `question` (with answers),
`readonly-deny`. Useful when you want to know what ran while you were away.

---

## 6. Attachments

Send a document, photo, video or voice note in the self-chat or a task group.

- It is downloaded to `workspace/inbox/<UTC stamp>-<original name>` (up to
  `CLAUDE_OFFICE_MAX_ATTACHMENT_MB`, default 200) and the path is appended
  to your caption as `[Attachment saved at: …]`, so Claude can open it.
- A file sent **without** a caption is held; you get `📎 Saved … Tell me what
  to do with it.` and the path is attached to your next message.
- Downloads that fail produce a note asking you to re-send.

---

## 7. Other people in a task group

Task groups are ordinary WhatsApp groups, so you can add a colleague to one.
With `CLAUDE_OFFICE_GROUP_MEMBERS=true` their messages are accepted, tagged
`[Message from <their WhatsApp name>]`, and run in **read-only mode**:

- Claude may look things up (kubectl get/describe/logs, aws describe/list,
  git log/diff, Jira/Confluence/mail/Teams reads, files, web) and answer
  them by name.
- Every write is blocked at the tool level: `Write`/`Edit` tools are
  disabled, and a `PreToolUse` hook plus `canUseTool` deny any shell command
  that is not on the read-only list (`kubectl apply`, `git push`, `curl -X
  POST`, redirections, `sed -i`, command substitution …) and any connector
  tool that creates, updates, sends or deletes. Denials are audited.
- Their messages **never** answer an approval or a question, and cannot run
  `/commands`; they are simply queued as instructions. Only your own messages
  count for approvals.
- Claude cannot ask them questions; it states assumptions instead. If the
  request needs a change it says so and waits for you to ask.
- The reply footer shows `🔎 read-only reply to <name>`.

With the flag off (default), messages from anyone but you are ignored in
groups.

---

## 8. Configuration reference

All settings are environment variables, read once at startup. Put them in
`.env` (the launchd installer copies them into the service) or export them
before `npm start`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_OFFICE_WORKSPACE` | `./workspace` | Claude's working directory; its `CLAUDE.md` is loaded as instructions. |
| `CLAUDE_OFFICE_STATE` | `./state` | WhatsApp auth, sessions, task store, audit log. |
| `CLAUDE_OFFICE_PAIRING_PHONE` | (empty) | Use a pairing code instead of a QR at link time. Digits only, with country code. |
| `CLAUDE_OFFICE_ALLOWED_SENDERS` | (empty) | Extra WhatsApp JIDs (`91…@s.whatsapp.net`) whose direct chats may command the agent. |
| `CLAUDE_OFFICE_GROUP_MEMBERS` | `false` | Accept messages from other members of task groups (read-only mode, §7). |
| `CLAUDE_OFFICE_PREFIX` | `🤖 ` | Prefix on every outgoing message; also how the bot ignores its own echoes. |
| `CLAUDE_OFFICE_PROGRESS` | `true` | Forward Claude's narration (💬). |
| `CLAUDE_OFFICE_VERBOSE_TOOLS` | `true` | One line per tool call and result (🔧 / ↳). |
| `CLAUDE_OFFICE_APPROVAL_TIMEOUT_MIN` | `60` | Minutes to wait for an approval/answer before treating it as "no". |
| `CLAUDE_OFFICE_MODEL` | (Claude Code default) | Model override, e.g. `claude-opus-5`. |
| `CLAUDE_OFFICE_MAX_TURNS` | `300` | Safety cap on agentic turns per instruction. |
| `CLAUDE_OFFICE_MAX_PARALLEL` | `3` | Concurrent Claude runs across all chats. |
| `CLAUDE_OFFICE_TASK_GROUPS` | `true` | `false` = every instruction runs inline in the self-chat, sequentially. |
| `CLAUDE_OFFICE_MAX_ATTACHMENT_MB` | `200` | Largest attachment to download. |
| `CLAUDE_OFFICE_QUIET` | `false` | Skip the "Online" message on startup (the service sets this). |
| `WA_LOG_LEVEL` | `warn` | Baileys log level. |

---

## 9. Files on disk

```
src/                 the service (see §1)
test/                node:test suites for the router, policy and formatting
bin/install-service.sh    write + load the launchd agent (reads .env)
bin/uninstall-service.sh  stop and remove it
bin/e2e-agent.ts     run the agent + approval relay without WhatsApp (scratch state dir)
bin/e2e-readonly.ts  prove a colleague's request cannot write anything
bin/smoke.mjs        one-shot SDK sanity check
bin/probe-group.mjs  check the account can create/rename a solo group (service stopped)
workspace/CLAUDE.md.example   template for the agent's standing instructions
workspace/CLAUDE.md  your copy (git-ignored)
workspace/JOURNAL.md the agent's running log (git-ignored)
workspace/inbox/     downloaded attachments (git-ignored)
state/wa-auth/       WhatsApp session keys  (git-ignored, secret)
state/session.json   session id of the inline self-chat
state/tasks.json     task groups → session ids, status, titles
state/audit.log      one JSON line per permission decision
logs/out.log, err.log  service output
```

Never commit `state/`, `.env` or the live `workspace/` files; `.gitignore`
already excludes them.

---

## 10. Operations

| Need | Command |
| --- | --- |
| Start in a terminal | `npm start` |
| Install/upgrade the service | `./bin/install-service.sh` (re-run after code or `.env` changes) |
| Restart the service | `launchctl kickstart -k gui/$(id -u)/com.pavan.claude-office` |
| Stop and remove it | `./bin/uninstall-service.sh` |
| Logs | `tail -f logs/out.log logs/err.log` |
| Re-link WhatsApp | stop the service, delete `state/wa-auth/`, `npm start`, scan again |
| Run tests / typecheck | `npm test`, `npm run typecheck` |

Restarting the service is safe mid-task: task groups and their session ids
are on disk, so a follow-up in any group resumes where it left off. The run
that was in flight is lost; re-send that instruction.

Only one process may hold the WhatsApp session. Do not run `npm start` while
the service is loaded, and stop the service before `bin/probe-group.mjs`.

---

## 11. Security model

- **Who can talk to it:** only your own account by default. Direct chats from
  other numbers are ignored unless listed in `CLAUDE_OFFICE_ALLOWED_SENDERS`.
  In groups: only your messages, or (opt-in) other members in read-only mode.
  The bot's own messages are prefixed and filtered out so it cannot loop.
- **What it can do:** everything your laptop user can, with your kubeconfigs,
  cloud profiles, SSH keys and connectors. That is the point, and the risk.
  The policy layer gates only destroy/delete actions; the standing
  instructions (`workspace/CLAUDE.md`) add the judgment calls (prefer dev,
  check the context before mutating, never send mail unless asked).
- **Approvals cannot be spoofed** by colleagues: the answer must come from
  your account, and read-only runs cannot write at all (hook + tool filter).
- **Secrets:** `state/wa-auth/` is a full WhatsApp session; `.env` may hold
  a phone number. Both are git-ignored. The claude.ai login is the CLI's own
  keychain item.
- **WhatsApp terms:** Baileys uses the unofficial multi-device web protocol.
  Meta forbids it and accounts are occasionally banned. Keep traffic to your
  own chats and small groups.

---

## 12. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No "Online" message after start | Service runs with `CLAUDE_OFFICE_QUIET=true`; check `logs/out.log` for `WhatsApp connected`. |
| `Logged out from WhatsApp` in the log, process exits with code 2 | The link was revoked on the phone. Delete `state/wa-auth/` and re-link. |
| Messages from you are ignored | The service ignores messages older than its start time; send a new one. Check you are writing in the self-chat or a task group, not another chat. |
| A colleague's messages are ignored | `CLAUDE_OFFICE_GROUP_MEMBERS` is not `true`, or the service was not restarted after changing `.env`. |
| `⚠️ Could not create a group … running here instead` | The account could not create a solo group; the task runs inline. Test with `bin/probe-group.mjs` (service stopped). |
| Keychain prompt on every run | Click **Always Allow** on the prompt for the Claude binary. |
| `Stopped: error_max_turns` | Raise `CLAUDE_OFFICE_MAX_TURNS` or split the task. |
| Approval prompt never arrived, action denied after an hour | You were not in the group; `/status` shows "Waiting for your answer". Re-run the instruction. |
| Replies look garbled | WhatsApp has no Markdown tables/headers; `format.ts` converts what it can. Ask for plainer output or fix `mdToWhatsApp`. |
| `link-preview-js` warnings in the log | Harmless; Baileys tries to build link previews. |

---

## 13. Development

```
npm test              # node:test suites (router, policy, formatting)
npm run typecheck     # tsc --noEmit
npm run e2e           # agent + approval relay against a scratch state dir
```

Where to change things:

- New destructive pattern → `src/policy.ts` `DESTRUCTIVE_SUBCOMMANDS`, plus a
  case in `test/policy.test.ts`.
- New read-only command for colleagues → `READ_ONLY_BINS` /
  `READ_ONLY_SUBCOMMANDS` in `src/policy.ts`.
- Behaviour of the agent (tone, what to ask, what to prefer) →
  `workspace/CLAUDE.md` (yours) or `SYSTEM_APPEND` in `src/agent.ts`
  (everyone's).
- Another chat transport → implement the `Transport` interface from
  `src/bridge.ts` (`send`, `setTyping`, `createGroup`, `renameGroup`,
  `selfChatJid`) and feed `InboundMessage`s to `Bridge.handle`.
