const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../voiceLoop.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS}
}).outputText, {exports: api});
(async () => {
  let active = true, rounds = 0, release;
  const pendingInference = new Promise(resolve => { release = resolve; });
  const running = api.runVoiceLoop(() => active, async () => {
    rounds++;
    if (rounds === 1) await pendingInference;
    else active = false;
  });
  await Promise.resolve();
  assert.equal(rounds, 1, 'do not record next utterance while inference is pending');
  release();
  await running;
  assert.equal(rounds, 2, 'automatically return to listening after inference');
  rounds = 0; active = false;
  await api.runVoiceLoop(() => active, async () => { rounds++; });
  assert.equal(rounds, 0, 'stop prevents new rounds');
  await assert.rejects(api.runVoiceLoop(() => true, async () => { throw Error('device failure'); }), /device failure/);
  console.log('PASS: sequential inference, automatic re-listening, stop and device failure');
})().catch(error => { console.error(error); process.exitCode = 1; });
