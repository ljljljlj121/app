const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const out = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../emotionHistory.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: out });
const frame = (id, time, tag = "negative", session = "1") => ({
  frameId: id, timestampMs: time, tag, sessionId: session, status: tag ? "valid" : "no_face",
});
const batch = (records, nowMs, sessionId = "1") => ({ records, nowMs, sessionId });
let history = out.appendFrames([], batch([frame(1, 0), frame(2, 2500, null), frame(3, 3000)], 3000));
assert.equal(history.length, 3);
assert.equal(out.visibleFrames(history, 3001).length, 2);
assert.equal(history[1].tag, null, "No face must retain null, not neutral");
history = out.appendFrames(history, batch([frame(3, 3000), frame(4, 3100)], 3100));
assert.equal(history.length, 4, "Deduplicate events without losing analyzed frames");
assert.equal(out.appendFrames(history, batch([], 3100)).length, 4, "Pause freezes the monotonic window");
assert.equal(out.appendFrames(history, batch([], 30001)).length, 3, "Evict records by time");
assert.equal(out.appendFrames(history, batch([frame(1, 3101, "positive", "2")], 3101, "2")).length, 1,
  "New session clears old records and accepts frame 1");
const many = Array.from({ length: 1000 }, (_, id) => frame(id + 1, id));
assert.equal(out.appendFrames([], batch(many, 1000)).length, 900, "Enforce capacity in addition to time");
const tags = Array.from(history, (item) => item.tag);
assert.deepEqual(tags, ["negative", null, "negative", "negative"]);
console.log("PASS: frame identity, raw tags, no-face, duplicate batches, pause, sessions, 3/30s windows, capacity");
