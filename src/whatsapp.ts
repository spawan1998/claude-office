// WhatsApp transport built on Baileys (WhatsApp Web multi-device protocol).
// Links your own phone number (QR or pairing code). Only messages you send in
// your own "message yourself" chat (or from explicitly allowed senders) are
// treated as instructions; replies go back into the same chat.
import path from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  jidNormalizedUser,
  type AnyMessageContent,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.ts";
import { attachmentFileName, splitMessage } from "./format.ts";

/** Enough of a WhatsApp message key to react to it later. */
export type MessageRef = { remoteJid: string; id: string; fromMe: boolean; participant?: string };

/** `attachments` are absolute paths of files saved under `<workspace>/inbox/`. */
export type InboundMessage = {
  chatJid: string; text: string; id: string; timestamp: number; attachments: string[];
  /** false when another member of a task group wrote it (see config.groupMembers); absent/true = the owner. */
  fromMe?: boolean;
  /** Raw key of the WhatsApp message, for reactions (⏳ picked up, ✅ done). */
  key?: MessageRef;
};

type MediaMeta = { fileName?: string | null; mimetype?: string | null; fileLength?: number | Long | null };
type Long = { toString(): string };

const stamp = () => new Date().toISOString().slice(11, 19);
const logLine = (...a: unknown[]) => console.log(stamp(), ...a);

export class WhatsApp {
  private sock: WASocket | null = null;
  private log = pino({ level: process.env.WA_LOG_LEVEL ?? "warn" });
  private selfJids = new Set<string>();
  private sentIds = new Set<string>();
  /** Newest inbound message timestamp (unix s) we processed; persisted so
   *  messages sent while the service was down are still handled after a restart. */
  private lastSeen = Math.floor(Date.now() / 1000);
  private lastSeenFile = path.join(config.stateDir, "last-seen.json");
  private seenIds: string[] = [];
  private stopping = false;
  private reconnectDelay = 2000;
  private connectedOnce = false;
  onMessage: (m: InboundMessage) => void = () => {};
  onReady: () => void = () => {};
  /** Which group chats we accept our own messages from (task groups). */
  allowGroup: (jid: string) => boolean = () => false;

  private loadLastSeen(): void {
    const floor = Math.floor(Date.now() / 1000) - 12 * 3600; // never replay more than 12 h of backlog
    try {
      const v = JSON.parse(fs.readFileSync(this.lastSeenFile, "utf8")).lastSeen;
      this.lastSeen = typeof v === "number" ? Math.max(v, floor) : floor;
    } catch {
      this.lastSeen = floor; // first run with this feature: pick up recent unanswered messages too
    }
    logLine(`inbound watermark: processing messages newer than ${new Date(this.lastSeen * 1000).toISOString()}`);
  }

  private saveLastSeen(): void {
    try { fs.writeFileSync(this.lastSeenFile, JSON.stringify({ lastSeen: this.lastSeen })); } catch { /* ignore */ }
  }

  async connect(): Promise<void> {
    const authDir = path.join(config.stateDir, "wa-auth");
    fs.mkdirSync(authDir, { recursive: true });
    if (!this.connectedOnce) this.loadLastSeen();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version: [number, number, number] | undefined;
    try { version = (await fetchLatestBaileysVersion()).version as [number, number, number]; } catch { version = undefined; }
    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.log) },
      logger: this.log,
      browser: ["claude-office", "Desktop", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    if (!state.creds.registered && config.pairingPhone) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(config.pairingPhone.replace(/\D/g, ""));
          console.log(`\n=== WhatsApp pairing code: ${code} ===\nOn your phone: WhatsApp > Linked devices > Link a device > Link with phone number instead.\n`);
        } catch (e) { console.error("pairing code request failed", e); }
      }, 3000);
    }

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u) => {
      // Events from a socket we already replaced must not trigger another reconnect.
      if (this.sock !== sock) return;
      if (u.qr && !config.pairingPhone) {
        console.log("\nScan this QR with WhatsApp > Linked devices > Link a device:\n");
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === "open") {
        this.reconnectDelay = 2000;
        this.connectedOnce = true;
        const me = sock.user;
        this.selfJids.clear();
        if (me?.id) this.selfJids.add(jidNormalizedUser(me.id));
        if (me?.lid) this.selfJids.add(jidNormalizedUser(me.lid));
        logLine(`WhatsApp connected as ${me?.id} (lid ${me?.lid ?? "-"})`);
        this.onReady();
      }
      if (u.connection === "close") {
        const err = u.lastDisconnect?.error as { output?: { statusCode?: number }; statusCode?: number; message?: string } | undefined;
        const code = err?.output?.statusCode ?? err?.statusCode;
        logLine(`WhatsApp connection closed (code ${code ?? "?"}${err?.message ? `: ${err.message}` : ""})`);
        if (this.stopping) return;
        if (code === DisconnectReason.loggedOut) {
          console.error("Logged out from WhatsApp. Delete state/wa-auth and re-link.");
          process.exit(2);
        }
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
        setTimeout(() => this.connect().catch((e) => console.error("reconnect failed", e)), delay);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" = live delivery; "append" = delivered from the server's offline
      // queue after a reconnect (or history). Both can carry instructions the
      // owner typed while we were disconnected, so both go through the
      // watermark + dedupe below instead of being dropped.
      for (const m of messages) this.handleInbound(m, type);
    });
  }

  private remember(id: string): void {
    this.seenIds.push(id);
    if (this.seenIds.length > 2000) this.seenIds.splice(0, 1000);
  }

  private handleInbound(m: WAMessage, upsertType: string): void {
    if (!m.message || !m.key?.remoteJid) return;
    const id = m.key.id ?? "";
    if (this.sentIds.has(id)) { this.sentIds.delete(id); return; }
    if (id && this.seenIds.includes(id)) return; // redelivered
    const ts = Number(m.messageTimestamp ?? 0);
    if (ts && ts < this.lastSeen) return; // older than what we already handled
    const chatJid = jidNormalizedUser(m.key.remoteJid);
    if (chatJid === "status@broadcast") return;
    const isGroup = chatJid.endsWith("@g.us");
    if (isGroup && !this.allowGroup(chatJid)) return;
    const msg = m.message;
    // Documents sent with a caption arrive wrapped in documentWithCaptionMessage.
    const doc = msg.documentMessage ?? msg.documentWithCaptionMessage?.message?.documentMessage;
    const media: MediaMeta | undefined = doc ?? msg.imageMessage ?? msg.videoMessage ?? msg.audioMessage ?? undefined;
    const text = (msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? doc?.caption ?? "").trim();
    if (!text && !media) return;
    if (text.startsWith(config.botPrefix.trim())) return; // our own output echoed back
    const fromMe = !!m.key.fromMe;
    const isSelfChat = this.selfJids.has(chatJid);
    const allowed = isGroup
      ? fromMe || config.groupMembers // in our task groups: our own messages, plus other members when enabled
      : (fromMe && isSelfChat) || (!fromMe && config.allowedSenders.includes(chatJid));
    if (!allowed) {
      logLine(`inbound ignored (${upsertType}) ${chatJid} fromMe=${fromMe} isSelf=${isSelfChat}: ${text.slice(0, 40).replace(/\n/g, " ")}`);
      return;
    }
    this.remember(id);
    if (ts > this.lastSeen) { this.lastSeen = ts; this.saveLastSeen(); }
    const late = ts && ts < Math.floor(Date.now() / 1000) - 60 ? ", late" : "";
    logLine(`inbound (${upsertType}${late}) ${chatJid} fromMe=${fromMe} ${media ? "[media] " : ""}${text.slice(0, 60).replace(/\n/g, " ")}`);
    // A group member's message is tagged so the agent knows who is talking.
    const who = m.pushName || (m.key.participant ? jidNormalizedUser(m.key.participant).split("@")[0] : "group member");
    const tagged = fromMe ? text : `[Message from ${who}]\n${text}`;
    const key: MessageRef = { remoteJid: m.key.remoteJid, id, fromMe, participant: m.key.participant ?? undefined };
    const base = { chatJid, id, timestamp: ts, fromMe, key };
    if (!media) { this.onMessage({ ...base, text: tagged, attachments: [] }); return; }
    void this.saveAttachment(m, media, ts).then((file) => {
      if (file) { this.onMessage({ ...base, text: tagged, attachments: [file] }); return; }
      const note = "[An attachment was sent but could not be downloaded; ask the user to re-send it]";
      this.onMessage({ ...base, text: tagged ? `${tagged}\n${note}` : note, attachments: [] });
    });
  }

  /** Download a media message into `<workspace>/inbox/` and return the absolute path (null on failure). */
  private async saveAttachment(m: WAMessage, media: MediaMeta, ts: number): Promise<string | null> {
    const size = Number(String(media.fileLength ?? 0));
    if (size > config.maxAttachmentBytes) {
      console.error(`attachment too large (${size} bytes > ${config.maxAttachmentBytes}); skipped`);
      return null;
    }
    const dir = path.join(config.workspace, "inbox");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, attachmentFileName(media.fileName, media.mimetype, new Date((ts || Date.now() / 1000) * 1000)));
    try {
      const stream = await downloadMediaMessage(m, "stream", {}, { logger: this.log, reuploadRequest: (msg) => this.sock!.updateMediaMessage(msg) });
      await pipeline(stream, fs.createWriteStream(file, { flags: "wx" }));
      console.log(`attachment saved: ${file}`);
      return file;
    } catch (e) {
      console.error("attachment download failed:", (e as Error).message);
      fs.rmSync(file, { force: true });
      return null;
    }
  }

  get selfChatJid(): string | undefined {
    return [...this.selfJids].find((j) => j.endsWith("@s.whatsapp.net")) ?? [...this.selfJids][0];
  }

  async send(chatJid: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    const parts = splitMessage(text, config.maxMessageChars);
    for (const part of parts) {
      const res = await this.sock.sendMessage(chatJid, { text: config.botPrefix + part });
      if (res?.key?.id) this.sentIds.add(res.key.id);
    }
  }

  /** Send a file from disk into a chat: pictures inline, everything else as a document. */
  async sendFile(chatJid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    const fileName = path.basename(filePath);
    const mimetype = mimeFor(fileName);
    const buf = fs.readFileSync(filePath);
    const text = caption ? config.botPrefix + caption : undefined;
    const content: AnyMessageContent = /^image\/(png|jpeg|webp)$/.test(mimetype)
      ? { image: buf, caption: text }
      : { document: buf, mimetype, fileName, caption: text };
    const res = await this.sock.sendMessage(chatJid, content);
    if (res?.key?.id) this.sentIds.add(res.key.id);
  }

  /** Create a group containing only this account; returns its JID. */
  async createGroup(subject: string): Promise<string> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    const meta = await this.sock.groupCreate(subject, []);
    return meta.id;
  }

  async renameGroup(jid: string, subject: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp not connected");
    await this.sock.groupUpdateSubject(jid, subject.slice(0, 100));
  }

  /**
   * "typing…" for the other members of the chat. WhatsApp shows this to other
   * people only, never to the account that is typing, and it expires after
   * ~10 s, so the Conversation re-sends it while a run is active.
   */
  async setTyping(chatJid: string, on: boolean): Promise<void> {
    try { await this.sock?.sendPresenceUpdate(on ? "composing" : "paused", chatJid); } catch { /* ignore */ }
  }

  /** React to a message in whichever chat it lives (empty emoji removes the reaction). Visible to the owner too. */
  async react(key: MessageRef, emoji: string): Promise<void> {
    if (!this.sock) return;
    try {
      const res = await this.sock.sendMessage(key.remoteJid, { react: { text: emoji, key } });
      if (res?.key?.id) this.sentIds.add(res.key.id);
    } catch (e) { console.error("react failed:", (e as Error).message); }
  }

  stop(): void {
    this.stopping = true;
    this.sock?.end(undefined);
  }
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4", mp3: "audio/mpeg", m4a: "audio/mp4",
};

export function mimeFor(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}
