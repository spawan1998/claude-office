import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentFileName } from "../src/format.ts";

const D = new Date("2026-09-28T10:15:30.123Z");

test("attachment names are stamped and sanitised", () => {
  assert.equal(attachmentFileName("test-sftp-e2e.sh", "text/x-sh", D), "20260928T101530Z-test-sftp-e2e.sh");
  assert.equal(attachmentFileName("my report (final).pdf", "application/pdf", D), "20260928T101530Z-my_report_final_.pdf");
  assert.equal(attachmentFileName("../../etc/passwd", null, D), "20260928T101530Z-passwd");
  assert.equal(attachmentFileName("..", null, D), "20260928T101530Z-attachment");
});

test("extension comes from the mime type when the name has none", () => {
  assert.equal(attachmentFileName(undefined, "image/jpeg", D), "20260928T101530Z-attachment.jpg");
  assert.equal(attachmentFileName("", "audio/ogg; codecs=opus", D), "20260928T101530Z-attachment.ogg");
  assert.equal(attachmentFileName("notes", "text/plain", D), "20260928T101530Z-notes.txt");
  assert.equal(attachmentFileName("blob", "application/x-unknown", D), "20260928T101530Z-blob");
});
