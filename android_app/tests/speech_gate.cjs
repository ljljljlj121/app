const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../speechGate.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS}
}).outputText, {exports: api});
const silent = new api.SpeechGate(200);
for (const t of [0, 3000, 15000, 600000, 3600000]) assert.equal(silent.feed(20, t), 'waiting');
assert.equal(silent.feed(300, 3600100), 'speaking');
assert.equal(silent.feed(300, 3600200), 'speaking', 'idle waiting does not consume speech duration');
assert.equal(silent.feed(20, 3600800), 'speech');
assert.equal(silent.feed(300, 3600900), 'speech', 'completed attempt cannot restart itself');
const long = new api.SpeechGate(200);
for (let t = 100; t < 15100; t += 100) assert.equal(long.feed(300, t), 'speaking');
assert.equal(long.feed(300, 15100), 'speech_limit');
console.log('PASS: indefinite silence, delayed onset, pause completion, 15s speech-only limit');
