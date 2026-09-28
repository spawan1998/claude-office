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

export class WhatsApp {
  private sock: WASocket | null = null;
  private log = pino({ level: process.env.WA_LOG_LEVEL ?? "warn" });
  private selfJids = new Set<string>();
  private sentIds = new Set<string>();
  private startedAt = Math.floor(Date.now() / 1000);
  private stopping = false;
  private reconnectDelay = 2000;
  onMessage: (m: InboundMessage) => void = () => {};
  onReady: () => void = () => {};
  /** Which group chats we accept our own messages from (task groups). */
  allowGroup: (jid: string) => boolean = () => false;

  async connect(): Promise<void> {
    const authDir = path.join(config.stateDir, "wa-auth");
    fs.mkdirSync(authDir, { recursive: true });
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
      if (u.qr && !config.pairingPhone) {
        console.log("\nScan this QR with WhatsApp > Linked devices > Link a device:\n");
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === "open") {
        this.reconnectDelay = 2000;
        const me = sock.user;
        this.selfJids.clear();
        if (me?.id) this.selfJids.add(jidNormalizedUser(me.id));
        if (me?.lid) this.selfJids.add(jidNormalizedUser(me.lid));
        console.log(`WhatsApp connected as ${me?.id} (lid ${me?.lid ?? "-"})`);
        this.onReady();
      }
      if (u.connection === "close") {
        const err = u.lastDisconnect?.error as { output?: { statusCode?: number }; statusCode?: number } | undefined;
        const code = err?.output?.statusCode ?? err?.statusCode;
        console.log(`WhatsApp connection closed (code ${code ?? "?"})`);
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
      if (type !== "notify") return;
      for (const m of messages) this.handleInbound(m);
    });
  }

  private handleInbound(m: WAMessage): void {
    if (!m.message || !m.key?.remoteJid) return;
    const id = m.key.id ?? "";
    if (this.sentIds.has(id)) { this.sentIds.delete(id); return; }
    const ts = Number(m.messageTimestamp ?? 0);
    if (ts && ts < this.startedAt - 5) return; // ignore history / offline backlog
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
    if (!allowed) return;
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
