// Exercise the actual Android VAD loop with a deterministic clock and microphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const text = fs.readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');
const file = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let branch;
function visit(node) {
  if (ts.isIfStatement(node) && node.elseStatement && ts.isBlock(node.elseStatement)
      && node.expression.getText(file) === 'selectedMode === "face_only"'
      && node.elseStatement.getText(file).includes('const threshold = Math.max(1, Number(settings.vadThreshold)')) {
    branch = node.elseStatement;
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert(branch, 'Find the production VAD loop');
const body = branch.statements.map(node => node.getText(file)).join('\n');
const code = ts.transpileModule(`async function run() {
  const startedAt = 0, silenceTimeout = 1.5, keepTailMs = 375;
  let trimTailMs = 0;
  ${body}
  return { elapsed: Date.now(), trimTailMs, threshold };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
async function scenario(setting) {
  let now = 0;
  const context = {
    settings: { vadThreshold: setting },
    Date: { now: () => now },
    sleep: async (ms) => { now += ms; },
    NativeRecorder: { getRms: async () => now <= 1000 ? 600 : 100 },
    setProgress() {}, setStatus() {},
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.run();
}
(async () => {
  for (const setting of ['200', '300', '']) {
    const result = await scenario(setting);
    assert(result.elapsed < 4000, '100 RMS must start the pause timer after speech at a threshold of 200/300');
    assert.equal(result.trimTailMs, 1125);
    assert.equal(result.threshold, setting ? Number(setting) : 200);
  }
  const low = await scenario('80');
  assert(low.elapsed >= 60000, '100 RMS must keep recording with the user-selected threshold 80');
  assert.equal(low.trimTailMs, 0);
  const high = await scenario('700');
  assert(high.elapsed >= 5000 && high.elapsed < 6000, 'A threshold of 700 must prevent onset for 600 RMS');
  assert.equal(high.trimTailMs, 0);
  console.log('PASS: phone thresholds 80/200/300/700 and default 200 apply across onset and continuation');
})().catch(error => { console.error(error); process.exitCode = 1; });
