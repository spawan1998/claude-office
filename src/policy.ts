// Decides which tool calls need your approval. Policy: everything runs on its
// own EXCEPT actions that destroy or delete something (resources, files,
// branches, records). Those are sent to the chat for a yes/no first.
//
// "Destructive" here means: rm/rmdir/shred/dd/mkfs, kubectl delete/drain,
// helm uninstall, argocd app delete, aws delete-*/terminate-*/s3 rm/rb,
// terraform destroy, git force-push / branch -D / reset --hard / clean /
// push --delete, docker rm/rmi/prune, package uninstalls, SQL DROP/DELETE/
// TRUNCATE, find -delete, and any connector tool whose name says delete,
// remove or trash. Everything else (apply, scale, push, commit, send mail,
// create Jira, write files, ssh, scripts) is auto-approved.
import path from "node:path";

export type Decision =
  | { kind: "allow"; reason: string }
  | { kind: "ask"; summary: string; detail: string };

const DESTRUCTIVE_BINS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "dd", "mkfs", "diskutil", "wipefs"]);

/** Options that take a separate value, so the value is never mistaken for a subcommand. */
const VALUE_OPTS: Record<string, Set<string>> = {
  kubectl: new Set(["--context", "-n", "--namespace", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--as", "--as-group",
    "--token", "-l", "--selector", "--field-selector", "-o", "--output", "-f", "--filename", "-c", "--container"]),
  helm: new Set(["--kube-context", "-n", "--namespace", "--kubeconfig", "-o", "--output", "-f", "--values", "--version", "--repo"]),
  aws: new Set(["--profile", "--region", "--output", "--endpoint-url", "--query"]),
  argocd: new Set(["--server", "--auth-token", "--grpc-web-root-path", "--config", "-o", "--output", "--project", "-p"]),
  git: new Set(["-C", "-c", "--git-dir", "--work-tree"]),
  gcloud: new Set(["--project", "--region", "--zone", "--format", "--account", "--configuration"]),
  az: new Set(["-g", "--resource-group", "-n", "--name", "--subscription", "-o", "--output"]),
  docker: new Set(["-H", "--host", "--context"]),
};

function stripValueOpts(args: string[], opts: Set<string> | undefined): string[] {
  if (!opts) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (opts.has(args[i])) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}
function nonFlags(args: string[]): string[] {
  return args.filter((x) => !x.startsWith("-"));
}

// bin -> returns a short reason when the invocation is destructive, else null
const DESTRUCTIVE_SUBCOMMANDS: Record<string, (args: string[]) => string | null> = {
  kubectl: (a) => {
    const [sub, sub2] = nonFlags(a);
    if (sub === "delete") return "kubectl delete";
    if (sub === "drain") return "kubectl drain (evicts pods)";
    if (sub === "apply" && a.includes("--prune")) return "kubectl apply --prune (deletes unlisted resources)";
    if (sub === "replace" && a.includes("--force")) return "kubectl replace --force (deletes and recreates)";
    if (sub === "config" && ["delete-context", "delete-cluster", "delete-user", "unset"].includes(sub2)) return `kubectl config ${sub2}`;
    return null;
  },
  helm: (a) => {
    const [sub] = nonFlags(a);
    if (["uninstall", "delete", "del", "un"].includes(sub)) return "helm uninstall";
    if (sub === "repo" && ["remove", "rm"].includes(nonFlags(a)[1])) return "helm repo remove";
    return null;
  },
  argocd: (a) => {
    const [sub, op] = nonFlags(a);
    if (["delete", "delete-resource"].includes(op)) return `argocd ${sub} ${op}`;
    if (sub === "app" && op === "sync" && a.includes("--prune")) return "argocd app sync --prune";
    return null;
  },
  aws: (a) => {
    const [svc, op] = nonFlags(a);
    if (!op) return null;
    if (/^(delete|terminate|destroy|purge|deregister|remove|disassociate|detach|revoke)[-a-z0-9]*$/.test(op)) return `aws ${svc} ${op}`;
    if (svc === "s3" && (op === "rm" || op === "rb" || (op === "sync" && a.includes("--delete")) || (op === "mv"))) return `aws s3 ${op}`;
    if (svc === "s3api" && /^(delete|abort)/.test(op)) return `aws s3api ${op}`;
    if (svc === "cloudformation" && op === "delete-stack") return "aws cloudformation delete-stack";
    return null;
  },
  gcloud: (a) => { const nf = nonFlags(a); return nf.some((x) => x === "delete" || x === "destroy") ? "gcloud delete" : null; },
  az: (a) => { const nf = nonFlags(a); return nf.includes("delete") || nf.includes("purge") ? "az delete" : null; },
  terraform: (a) => {
    const [sub, sub2] = nonFlags(a);
    if (sub === "destroy") return "terraform destroy";
    if (sub === "apply" && a.includes("-destroy")) return "terraform apply -destroy";
    if (sub === "state" && ["rm", "replace-provider"].includes(sub2)) return `terraform state ${sub2}`;
    if (sub === "workspace" && sub2 === "delete") return "terraform workspace delete";
    if (sub === "force-unlock") return "terraform force-unlock";
    return null;
  },
  tofu: (a) => DESTRUCTIVE_SUBCOMMANDS.terraform(a),
  git: (a) => {
    const [sub, sub2] = nonFlags(a);
    const flags = a.filter((x) => x.startsWith("-"));
    if (sub === "push" && (flags.some((f) => /^(-f|--force|--force-with-lease.*|-d|--delete|--prune|--mirror)$/.test(f)) || nonFlags(a).some((x) => x.startsWith(":")))) return "git push --force/--delete";
    if (sub === "branch" && flags.some((f) => /^(-d|-D|--delete|-M|-m|--move)$/.test(f) || /^-[a-zA-Z]*[dD]/.test(f))) return "git branch delete/rename";
    if (sub === "tag" && flags.some((f) => /^(-d|--delete)$/.test(f))) return "git tag -d";
    if (sub === "reset" && flags.includes("--hard")) return "git reset --hard";
    if (sub === "clean") return "git clean";
    if (sub === "checkout" && (a.includes("--") || a.includes(".")) && !flags.includes("-b")) return "git checkout -- (discards changes)";
    if (sub === "restore" && !flags.includes("--staged")) return "git restore (discards changes)";
    if (sub === "stash" && ["drop", "clear"].includes(sub2)) return `git stash ${sub2}`;
    if (sub === "remote" && ["remove", "rm"].includes(sub2)) return "git remote remove";
    if (sub === "worktree" && ["remove", "prune"].includes(sub2)) return `git worktree ${sub2}`;
    if (sub === "rebase" || sub === "filter-branch" || sub === "filter-repo") return `git ${sub} (rewrites history)`;
    if (sub === "gc" && flags.includes("--prune=now")) return "git gc --prune=now";
    return null;
  },
  docker: (a) => {
    const nf = nonFlags(a);
    if (["rm", "rmi", "kill"].includes(nf[0])) return `docker ${nf[0]}`;
    if (nf[1] === "rm" || nf[1] === "prune" || nf[1] === "remove") return `docker ${nf[0]} ${nf[1]}`;
    if (nf[0] === "compose" && nf.includes("down") && (a.includes("-v") || a.includes("--volumes") || a.includes("--rmi"))) return "docker compose down with volume/image removal";
    return null;
  },
  gh: (a) => { const nf = nonFlags(a); return nf.includes("delete") || (nf[0] === "api" && a.some((x, i) => (x === "-X" || x === "--method") && a[i + 1] === "DELETE")) ? "gh delete" : null; },
  brew: (a) => (["uninstall", "remove", "rm", "purge", "cleanup"].includes(nonFlags(a)[0]) ? `brew ${nonFlags(a)[0]}` : null),
  npm: (a) => (["uninstall", "remove", "rm", "un", "unpublish", "deprecate"].includes(nonFlags(a)[0]) ? `npm ${nonFlags(a)[0]}` : null),
  pip: (a) => (nonFlags(a)[0] === "uninstall" ? "pip uninstall" : null),
  pip3: (a) => (nonFlags(a)[0] === "uninstall" ? "pip uninstall" : null),
  launchctl: (a) => (["bootout", "remove", "unload"].includes(nonFlags(a)[0]) ? `launchctl ${nonFlags(a)[0]}` : null),
  crontab: (a) => (a.includes("-r") ? "crontab -r" : null),
  find: (a) => (a.includes("-delete") ? "find -delete" : (a.includes("-exec") && /\brm\b/.test(a.join(" ")) ? "find -exec rm" : null)),
  xargs: (a) => (/\b(rm|rmdir|shred|kubectl delete|helm uninstall)\b/.test(a.join(" ")) ? "xargs rm/delete" : null),
  truncate: () => "truncate",
  jenkins: () => null,
};

const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema|index|user|role)|delete\s+from|truncate\s+(table\s+)?[a-z_"`.]+)\b/i;

/** Very small shell tokenizer: honours quotes, splits on pipes / && / ; / || / newlines. */
export function splitCommands(cmd: string): string[][] {
  const segments: string[][] = [];
  let cur: string[] = [];
  let tok = "";
  let q: string | null = null;
  let hasTok = false;
  const push = () => { if (hasTok) { cur.push(tok); tok = ""; hasTok = false; } };
  const endSeg = () => { push(); if (cur.length) segments.push(cur); cur = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < cmd.length) tok += cmd[++i];
      else tok += c;
      hasTok = true;
      continue;
    }
    if (c === '"' || c === "'") { q = c; hasTok = true; continue; }
    if (c === "\\" && i + 1 < cmd.length) { tok += cmd[++i]; hasTok = true; continue; }
    if (c === "|" || c === ";" || c === "\n" || (c === "&" && cmd[i + 1] === "&")) {
      if (c === "&") i++;
      if (c === "|" && cmd[i + 1] === "|") i++;
      endSeg();
      continue;
    }
    if (/\s/.test(c)) { push(); continue; }
    tok += c; hasTok = true;
  }
  endSeg();
  return segments;
}

/** Returns the reason a shell command is destructive, or null when it is not. */
export function destructiveReason(command: string): string | null {
  const trimmed = command.trim();
  if (SQL_DESTRUCTIVE.test(trimmed)) return "SQL drop/delete/truncate";
  for (let seg of splitCommands(trimmed)) {
    while (seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0])) seg = seg.slice(1);
    while (seg.length && ["command", "exec", "time", "nice", "caffeinate", "env", "sudo", "doas", "nohup"].includes(seg[0])) seg = seg.slice(1);
    if (seg.length === 0) continue;
    const bin = path.basename(seg[0]);
    const args = stripValueOpts(seg.slice(1), VALUE_OPTS[bin]);
    if (DESTRUCTIVE_BINS.has(bin)) return bin;
    // command substitution inside a segment: inspect the inner command too
    const inner = seg.join(" ").match(/\$\(([^)]*)\)|`([^`]*)`/g);
    if (inner) {
      for (const s of inner) {
        const r = destructiveReason(s.replace(/^\$\(|^`|\)$|`$/g, ""));
        if (r) return r;
      }
    }
    const check = DESTRUCTIVE_SUBCOMMANDS[bin];
    if (check) {
      const r = check(args);
      if (r) return r;
    }
    // interpreters running inline code that deletes things
    if (["python", "python3", "node", "ruby", "perl", "bash", "sh", "zsh"].includes(bin)) {
      const code = args.join(" ");
      if (/\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rmtree|rm_rf|rm_r)\s*\(|\bos\.(remove|unlink|rmdir)\b|\bshutil\.rmtree\b|\bFileUtils\.rm|\brm -/.test(code)) return `${bin} inline delete`;
    }
  }
  return null;
}

export function classifyBash(command: string): Decision {
  const reason = destructiveReason(command);
  if (reason) return { kind: "ask", summary: `destructive: ${reason}`, detail: command.trim() };
  return { kind: "allow", reason: "not destructive" };
}

// ---------------------------------------------------------------------------
// Read-only mode (requests from other group members): only lookups may run.
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "TodoRead", "NotebookRead",
  "Task", "Agent", "ToolSearch", "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool",
  "BashOutput", "TaskOutput", "Monitor",
]);

const READ_ONLY_BINS = new Set([
  "cat", "ls", "pwd", "echo", "printf", "head", "tail", "grep", "egrep", "fgrep", "rg", "find", "wc",
  "sort", "uniq", "cut", "awk", "tr", "jq", "yq", "date", "whoami", "hostname", "which", "type",
  "env", "printenv", "file", "stat", "du", "df", "basename", "dirname", "realpath", "readlink",
  "diff", "cmp", "md5", "shasum", "sha256sum", "base64", "less", "more", "true", "false", "test",
  "[", "column", "nl", "seq", "uname", "sw_vers", "id", "groups", "ps", "top", "lsof", "netstat",
  "dig", "nslookup", "host", "ping", "traceroute", "openssl", "nc", "ss", "ip", "ifconfig", "arp",
  "uptime", "cal", "bc", "expr", "strings", "od", "hexdump", "xxd", "tree", "man", "sleep", "time",
]);

function firstNonFlag(args: string[]): string { return args.find((x) => !x.startsWith("-")) ?? ""; }

const READ_ONLY_SUBCOMMANDS: Record<string, (args: string[]) => boolean> = {
  kubectl: (a) => {
    const sub = firstNonFlag(a);
    if (["get", "describe", "logs", "top", "explain", "version", "api-resources", "api-versions", "cluster-info", "events", "diff"].includes(sub)) return true;
    if (sub === "auth") return firstNonFlag(a.slice(a.indexOf("auth") + 1)) === "can-i";
    if (sub === "config") return ["get-contexts", "current-context", "view", "get-clusters", "get-users"].includes(firstNonFlag(a.slice(a.indexOf("config") + 1)));
    if (sub === "rollout") return ["status", "history"].includes(firstNonFlag(a.slice(a.indexOf("rollout") + 1)));
    return false;
  },
  helm: (a) => ["list", "ls", "get", "status", "history", "show", "template", "search", "version", "env", "lint"].includes(firstNonFlag(a)),
  aws: (a) => {
    const [svc, op] = nonFlags(a);
    if (!op) return false;
    if (/^(describe|list|get|search|lookup|query|scan|batch-get|check|estimate|preview|simulate|test|validate)[-a-z0-9]*$/.test(op)) return true;
    if (svc === "s3" && op === "ls") return true;
    if (svc === "logs" && ["filter-log-events", "tail", "start-query", "get-query-results"].includes(op)) return true;
    return false;
  },
  git: (a) => {
    const sub = firstNonFlag(a);
    if (["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-remote", "blame", "describe", "shortlog", "reflog", "cat-file", "grep", "fetch", "rev-list", "ls-tree"].includes(sub)) return true;
    if (sub === "branch") return a.slice(a.indexOf("branch") + 1).every((x) => x.startsWith("-") && !/^(-d|-D|-m|-M|--delete|--move)$/.test(x));
    if (sub === "config") return a.includes("--get") || a.includes("--list") || a.includes("-l");
    if (sub === "remote") { const r = a.slice(a.indexOf("remote") + 1); return r.length === 0 || r[0] === "-v" || r[0] === "show" || r[0] === "get-url"; }
    if (sub === "stash") return ["list", "show"].includes(a.slice(a.indexOf("stash") + 1)[0]);
    if (sub === "tag") { const r = a.slice(a.indexOf("tag") + 1); return r.length === 0 || r.includes("-l") || r.includes("--list"); }
    return false;
  },
  argocd: (a) => {
    const [sub, op] = nonFlags(a);
    if (sub === "version" || sub === "context") return true;
    return ["app", "proj", "repo", "cluster", "appset"].includes(sub) && ["get", "list", "diff", "history", "manifests", "resources", "logs"].includes(op);
  },
  docker: (a) => ["ps", "images", "inspect", "logs", "version", "info", "stats", "top", "port", "history", "search"].includes(firstNonFlag(a)),
  gh: (a) => {
    const [sub, op] = nonFlags(a);
    if (sub === "api") return !a.some((x) => /^(-X|--method|-F|-f|--field|--raw-field|--input)$/.test(x)) || a.includes("GET");
    return ["pr", "issue", "run", "release", "repo", "workflow"].includes(sub) && ["view", "list", "status", "diff", "checks"].includes(op) || sub === "search";
  },
  curl: (a) => !a.some((x) => /^(-X|--request|-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|-T|--upload-file|--json|-o|--output|-O)$/.test(x) || (/^-[a-zA-Z]*[XdFTo]/.test(x) && !x.startsWith("--"))),
  sed: (a) => !a.some((x) => x === "-i" || (/^-[a-zA-Z]*i/.test(x) && !x.startsWith("--"))),
  yq: (a) => !a.includes("-i") && !a.includes("--inplace"),
  terraform: (a) => ["plan", "show", "output", "validate", "version", "providers", "graph"].includes(firstNonFlag(a)),
  npm: (a) => ["view", "ls", "list", "outdated", "info", "search", "why", "explain"].includes(firstNonFlag(a)),
  brew: (a) => ["list", "info", "search", "config", "doctor", "outdated", "deps", "uses"].includes(firstNonFlag(a)),
  trivy: () => true,
};

/** Reason a shell command is NOT read-only, or null when it only reads. */
export function writeReason(command: string): string | null {
  const trimmed = command.trim();
  const stripped = trimmed.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "").replace(/[12&]?>>?\s*\/dev\/null/g, "").replace(/2>&1|>&2|1>&2/g, "");
  if (/(^|[^<>])>{1,2}\s*[^\s&|;]/.test(stripped)) return "writes a file via redirection";
  if (/\$\(|`/.test(trimmed)) return "command substitution (cannot verify it is read-only)";
  for (let seg of splitCommands(trimmed)) {
    while (seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0])) seg = seg.slice(1);
    while (seg.length && ["command", "time", "env"].includes(seg[0])) seg = seg.slice(1);
    if (seg.length === 0) continue;
    const bin = path.basename(seg[0]);
    if (["cd", "export", "set", "unset", "source", "."].includes(bin)) continue;
    const args = stripValueOpts(seg.slice(1), VALUE_OPTS[bin]);
    const pred = READ_ONLY_SUBCOMMANDS[bin];
    if (pred) { if (!pred(args)) return `${bin} ${firstNonFlag(args)}`.trim(); continue; }
    if (READ_ONLY_BINS.has(bin)) continue;
    return bin;
  }
  return null;
}

const MCP_READ = /^(get|list|search|fetch|read|find|lookup|query|describe|show|check|atlassianUserInfo|get_me|get_granted_scopes)/i;
const MCP_MUTATING = /(delete|remove|send|create|update|modify|trash|move|copy|rename|upload|respond|set_|transition|add|edit|forward|batch|reply)/i;

/** For read-only mode: reason a tool call would change something, or null when it only reads. */
export function readOnlyViolation(toolName: string, input: Record<string, unknown>): string | null {
  if (READ_ONLY_TOOLS.has(toolName)) return null;
  if (toolName === "Bash") { const r = writeReason(String(input.command ?? "")); return r ? `shell: ${r}` : null; }
  if (toolName.startsWith("mcp__")) {
    const tool = toolName.split("__").pop() ?? toolName;
    if (MCP_READ.test(tool) && !MCP_MUTATING.test(tool)) return null;
    // connector reads that don't start with a read verb (outlook_email_search, teams_list_chats …)
    if (/(_search|_list|_get|_read|_find|calendar_search|folder_search)/i.test(tool) && !MCP_MUTATING.test(tool)) return null;
    return `connector: ${tool}`;
  }
  return toolName; // Write, Edit, NotebookEdit, MultiEdit, AskUserQuestion, anything unknown
}

const MCP_DESTRUCTIVE = /(delete|remove|trash|destroy|purge|unlink|batch_delete|revoke)/i;

export function classify(toolName: string, input: Record<string, unknown>, _workspace: string): Decision {
  if (toolName === "Bash") return classifyBash(String(input.command ?? ""));
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const tool = parts[parts.length - 1];
    if (MCP_DESTRUCTIVE.test(tool) && !/untrash/i.test(tool)) {
      return { kind: "ask", summary: `destructive: ${tool.replace(/_/g, " ")}`, detail: JSON.stringify(input, null, 1).slice(0, 1200) };
    }
    return { kind: "allow", reason: "connector call (non-destructive)" };
  }
  // Read/Write/Edit/Glob/Grep/WebFetch/Agent/… never delete anything by themselves.
  return { kind: "allow", reason: "non-destructive tool" };
}
