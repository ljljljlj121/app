const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const api = {};
const jsx = (type, props) => ({ type, props });
const source = fs.readFileSync(path.join(__dirname, "../SpeechResults.tsx"), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
vm.runInNewContext(code, {
  exports: api,
  require(name) {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react-native") return { View: "View", Text: "Text", StyleSheet: { create: x => x } };
    return {};
  },
});
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object") return text(node.props?.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const completed = {
  id: "1", localStatus: "completed", cloudStatus: "completed",
  fusionTag: "positive", fusionMode: "A2_F3", cloudTag: "happy",
  transcript: "today is good",
};
const render = records => text(api.SpeechHighlights({ batch: { records } }));
assert.match(render([completed]), /积极 \/ positive/);
assert.match(render([completed]), /高兴 \/ happy/);
const recording = { id: "2", localStatus: "recording", cloudStatus: "recording", liveTranscript: "new speech" };
const current = render([completed, recording]);
assert.match(current, /#2/);
assert.match(current, /录制中/);
assert.match(current, /new speech/);
assert.doesNotMatch(current, /happy|positive|today is good/);
const failed = render([{ ...completed, cloudStatus: "failed", localStatus: "failed", fusionMode: "visual_only" }]);
assert.match(failed, /仅视觉/);
assert.match(failed, /失败/);
assert.doesNotMatch(failed, /happy/);
const unavailable = render([{ id: "3", localStatus: "completed", cloudStatus: "failed", fusionMode: "unavailable" }]);
assert.match(unavailable, /无有效结果/);
assert.doesNotMatch(unavailable, /neutral/);
assert.match(render([]), /等待讲话/);
console.log("PASS: newest utterance, independent statuses, visual fallback, no stale cloud label or invented neutral");
