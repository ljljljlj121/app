const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
const calls = [];
let responses = [];
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../cloudEmotion.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS}
}).outputText, {exports: api, fetch: async (url, options) => {
  calls.push(JSON.parse(options.body));
  return responses.shift();
}});
const ok = content => ({ok: true, json: async () => ({choices: [{message: {content}}]})});
const job = {video:'video', audio:'audio', id:1, kind:'idle'};
(async () => {
  responses = [{status:400}, ok('happy')];
  assert.equal(await api.inferEmotion(job, 'http://test/v1', 'key', 'model', {}), 'happy');
  assert.equal(calls.length, 2);
  assert(calls[1].guided_choice);
  responses = [ok('sad')];
  assert.equal(await api.inferEmotion(job, 'http://test/v1', 'key', 'model', {}), 'sad');
  assert.equal(calls.length, 3, 'reuse accepted mode without another 400 request');
  assert(calls[2].guided_choice);
  responses = [ok('happy because...')];
  await assert.rejects(api.inferEmotion(job, 'http://test/v1', 'key', 'model', {}), /有效/);
  responses = [{status:503, ok:false}];
  await assert.rejects(api.inferEmotion(job, 'http://test/v1', 'key', 'model', {}), /503/);
  console.log('PASS: constrained-mode fallback/cache, invalid labels, HTTP errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
