# claude-office

Control Claude from WhatsApp. You message yourself on WhatsApp; a small service
on this Mac hands the instruction to Claude (the Claude Code engine, via the
Claude Agent SDK, under your existing claude.ai login), Claude does the work on
this laptop with its real kubeconfigs, AWS profiles, SSH keys, Zscaler and the
Atlassian / Microsoft 365 connectors, and replies in the same chat. Only
destructive or delete actions ask you first, in the chat.

```
WhatsApp (your phone)  ──►  Baileys link (this Mac)  ──►  Claude Agent SDK  ──►  tools on this Mac
        ▲                                                       │
        └──── replies, progress notes, approval prompts, questions ◄──┘
```

**Full guide:** [docs/GUIDE.md](docs/GUIDE.md) — architecture, the message
flow step by step, setup, daily use, approvals, colleagues in a group,
configuration reference, operations, security model, troubleshooting.

## Setup (once)

1. `npm install` (already done).
2. First run in a terminal so you can scan the QR:

   ```
   cd /Users/pavan/Desktop/hilabs/claude-office
   npm start
   ```

   Phone: WhatsApp › Linked devices › Link a device › scan. Prefer a pairing
   code instead? Put `CLAUDE_OFFICE_PAIRING_PHONE=91XXXXXXXXXX` in `.env` and
   `set -a; source .env` before `npm start`.
3. When the terminal prints `WhatsApp connected`, open the *You* (message
   yourself) chat on your phone. You get an "Online" message. Send `/help`,
   then something harmless like `what kube contexts do I have?`.
4. macOS may pop a Keychain prompt the first time the SDK's bundled Claude
   binary reads your claude.ai login. Click **Always Allow**.
5. Install as a background service so it survives logout and crashes:

   ```
   ./bin/install-service.sh
   ```

   Logs: `logs/out.log`, `logs/err.log`. Stop: `./bin/uninstall-service.sh`.

The laptop must be awake and online. On power, set System Settings › Battery ›
Options › "Prevent automatic sleeping when the display is off", or run
`caffeinate -s` in a terminal.

## Using it

Your self-chat ("You") is the *launcher*. Every instruction you type there
starts a new task in its own WhatsApp group named `#<id> · <first words>`, with
its own Claude session. Open that group for the live feed, approvals and the
result; type there to answer prompts or add follow-ups (same session). Up to
`CLAUDE_OFFICE_MAX_PARALLEL` (default 3) tasks run at once; the rest wait for a
slot. When a task finishes its group is renamed `✅ #id …` (or `⚠️` on failure),
so your chat list doubles as a task board; archive groups you are done with.

Launcher commands: `/tasks` (recent tasks and slots), `/cancel <id>`,
`/here <instruction>` (run inline in the self-chat, sequential, like v1).
Inside a task group, `/rename <title>` renames the task and its group.
Files Claude produces (it copies them to `workspace/outbox/<task id>/`) are
sent back into the chat as attachments after its reply.
Set `CLAUDE_OFFICE_TASK_GROUPS=false` to make inline the default.

Examples of instructions:

- `why is pda-backend build 464 failing on jenkins?`
- `scale niq-rulesgenerator-backend to 0 in hilabs-dev-eks` (runs; deletes would ask)
- `draft a reply to Swapnesh's last mail about the GPU nodepool` (draft only)
- `check my calendar for tomorrow and list Jira tickets assigned to me`

Commands: `/help`, `/status`, `/cancel`, `/new` (fresh session), `/queue`,
`/clearqueue`, `/verbose on|off` (live feed of every tool call and result,
default on), `/progress on|off` (Claude's narration between calls, default on),
`/heartbeat <seconds>|off` ("still working" note after that much silence,
default 60).

While a task runs you see the same thing the terminal would show: 💬 lines are
Claude's narration, 🔧 lines are tool calls (tool · Claude's description ·
command/file), ↳ lines are one-line result summaries. Tool lines are batched
into one message every ~2.5 s.

Knowing whether it is still alive: your instruction message gets a ⏳ reaction
when Claude picks it up and ✅ (or ⚠️) when the reply is complete; the reply
ends with a `done · N turns · Ns` line; and if nothing has been posted for 60 s
while a run is active you get a `⏳ Still working… N min so far` note with the
last tool step. WhatsApp's own "typing…" dots are sent as well, but WhatsApp
only shows them to *other* members of the chat, never to the account that is
typing (which is you), so colleagues in a group see dots and you see the
reactions/heartbeat instead.

Approvals look like:

```
🔐 Approval #3 – Bash
destructive: kubectl delete
kubectl delete pod niq-rulesgenerator-backend-7d9f-abcde -n niq
Why: Pod is stuck Terminating for 40 min after the node was drained; the
Deployment recreates it. Skipping leaves the stale pod blocking the rollout.
Claude said: The rollout is blocked by one stale pod on ip-10-1-3-7 …
Reply yes / no / always, or tell me what to do instead.
```

Reply `yes`, `no`, `always` (remember this rule for the session), or type what
you want instead; the text is passed to Claude as the reason. Every approval
carries Claude's justification (*Why*, from the tool call's description) and
what it said just before the call; if *Why* is missing, ask before approving.

Questions from Claude are numbered; reply with the number(s) or free text.

Attachments: send a document, photo, video or voice note in the chat. It is
downloaded to `workspace/inbox/<UTC stamp>-<name>` and the path is appended to
the caption as `[Attachment saved at: …]`. A file sent without a caption is
held and attached to your next message. Files above
`CLAUDE_OFFICE_MAX_ATTACHMENT_MB` (default 200) are skipped with a note.

## Other people in a task group

If you add colleagues to a task group (`CLAUDE_OFFICE_GROUP_MEMBERS=true`,
the default), their messages are handed to the task as "[Message from <name>]"
and run in **read-only mode**: the agent may look things up (kubectl get,
aws describe, git log, Jira/Confluence/mail reads, files) and reply, but every
write, apply, delete, push, mail send or ticket update is blocked at the tool
level by a PreToolUse hook, and it cannot ask them questions. Only your own
messages can answer approvals, run commands, or make changes.

## What is auto-approved vs asked

Policy: **everything runs on its own except destroy/delete actions.**

Auto: all reads, all file writes and edits, `kubectl apply/scale/patch/rollout`,
`helm upgrade/rollback`, `argocd app sync`, `git commit/push/checkout`, `aws`
create/update/stop, `terraform apply`, `ssh`, `sudo`, scripts, `curl` POSTs,
sending mail or Teams messages, creating/updating Jira and Confluence.

Asked (a yes/no in the chat): `rm`/`rmdir`/`shred`/`dd`, `kubectl delete/drain`,
`kubectl apply --prune`, `helm uninstall`, `argocd app delete` or `sync --prune`,
`aws … delete-*/terminate-*/deregister-*`, `aws s3 rm/rb/sync --delete`,
`terraform destroy`/`state rm`, `git push --force/--delete`, `git branch -D`,
`git tag -d`, `git reset --hard`, `git clean`, `git checkout -- .`, `git restore`,
`git rebase`, `docker rm/rmi/prune`, `docker compose down -v`, `gh … delete`,
`brew/npm/pip uninstall`, `launchctl bootout`, `crontab -r`, `find -delete`,
`xargs rm`, SQL `DROP/DELETE FROM/TRUNCATE`, inline `shutil.rmtree`/`fs.rm`, and
connector tools named delete/remove/trash (mail, events, SharePoint items, docs).
Rules live in `src/policy.ts`; `npm test` exercises them.

Every decision is logged to `state/audit.log`.

## Layout

```
src/index.ts     entry point
src/whatsapp.ts  WhatsApp link (Baileys), self-chat gating, sending
src/bridge.ts    router: launcher self-chat, one group + session per task, slots
src/conversation.ts  one chat thread: queue, commands, prompts, batched feed
src/agent.ts     Agent SDK query() with resume + canUseTool relay
src/policy.ts    allow/ask classification
src/format.ts    markdown → WhatsApp formatting, message splitting
workspace/       agent cwd: CLAUDE.md (its standing instructions), JOURNAL.md, inbox/ (WhatsApp attachments)
state/           wa-auth/ (WhatsApp session), session.json (self-chat), tasks.json (task groups + their sessions), audit.log
bin/             install/uninstall service, smoke tests
```

## Caveats

- WhatsApp linking uses the unofficial multi-device web protocol (Baileys).
  Meta's terms forbid it; accounts are occasionally banned. Keep traffic to your
  own self-chat and don't use it to message others.
- The session runs under your claude.ai Team subscription and counts against its
  usage limits.
- Only your own messages (and JIDs in `CLAUDE_OFFICE_ALLOWED_SENDERS`) are
  accepted. In task groups only your own messages count unless
  `CLAUDE_OFFICE_GROUP_MEMBERS=true`, in which case people you add to a task
  group can also talk to the agent: their messages arrive as
  `[Message from <name>]` and are always plain instructions (they cannot
  answer approval prompts or run `/commands`). Other groups and status
  updates are ignored.
- Teams: not wired up in v1. The Microsoft 365 connector lets Claude read/send
  Teams messages when asked, but there is no Teams inbound channel yet.
