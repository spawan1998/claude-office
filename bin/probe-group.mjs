// One-off probe: can this account create a WhatsApp group with only itself in it,
// post to it, and rename it? Run with the service STOPPED (same auth state).
//   node bin/probe-group.mjs
import path from "node:path";
import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, jidNormalizedUser } from "@whiskeysockets/baileys";
import pino from "pino";

const log = pino({ level: "silent" });
const authDir = path.join(process.cwd(), "state", "wa-auth");
const { state, saveCreds } = await useMultiFileAuthState(authDir);
const { version } = await fetchLatestBaileysVersion();
const sock = makeWASocket({ version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) }, logger: log, browser: ["claude-office", "Desktop", "1.0.0"], markOnlineOnConnect: false, syncFullHistory: false });
sock.ev.on("creds.update", saveCreds);

const done = (code) => { try { sock.end(undefined); } catch {} setTimeout(() => process.exit(code), 500); };
setTimeout(() => { console.log("TIMEOUT"); done(3); }, 40000);

sock.ev.on("connection.update", async (u) => {
  if (u.qr) { console.log("QR requested — not linked?"); done(2); }
  if (u.connection !== "open") return;
  console.log("connected as", sock.user?.id, "lid", sock.user?.lid);
  try {
    let meta;
    try {
      meta = await sock.groupCreate("claude-office probe (delete me)", []);
      console.log("groupCreate([]) OK:", meta.id, "participants:", meta.participants?.map((p) => p.id));
    } catch (e) {
      console.log("groupCreate([]) failed:", e?.message || e);
      const self = jidNormalizedUser(sock.user.id);
      meta = await sock.groupCreate("claude-office probe (delete me)", [self]);
      console.log("groupCreate([self]) OK:", meta.id, "participants:", meta.participants?.map((p) => p.id));
    }
    const r = await sock.sendMessage(meta.id, { text: "🤖 probe message — this group can be deleted" });
    console.log("sendMessage OK:", r?.key?.id);
    await sock.groupUpdateSubject(meta.id, "✅ claude-office probe (delete me)");
    console.log("groupUpdateSubject OK");
    done(0);
  } catch (e) {
    console.log("PROBE FAILED:", e?.message || e, e?.data ? JSON.stringify(e.data).slice(0, 300) : "");
    done(1);
  }
});
