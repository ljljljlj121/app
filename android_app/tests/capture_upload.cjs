const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
class Multipart {
  fields = [];
  append(name, value) { this.fields.push([name, value]); }
}
const source = fs.readFileSync(path.join(__dirname, '../captureUpload.ts'), 'utf8');
const api = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, FormData: Multipart });
for (const [video, hasAudio] of [
  ['file:///data/user/0/app/cache/original.mp4', false],
  ['/data/user/0/app/cache/trimmed-video.mp4', true],
  ['content://camera/original', false],
]) {
  const form = api.captureFormData({ videoUri: video, wavPath: '/data/user/0/app/cache/audio.wav', mergedPath: '/data/user/0/app/cache/merged.mp4', hasAudio }, ' android-test ');
  const fields = Object.fromEntries(form.fields);
  assert.equal(fields.board_id, 'android-test');
  assert.equal(fields.has_audio, String(hasAudio));
  for (const key of ['video', 'audio', 'merged']) {
    assert(/^(file|content):\/\//.test(fields[key].uri), `${key} must have a readable Android URI scheme`);
  }
  assert.equal(fields.video.uri, video.startsWith('/') ? `file://${video}` : video);
  assert.equal(fields.video.name, 'video.mp4');
  assert.equal(fields.audio.name, 'audio.wav');
  assert.equal(fields.merged.name, 'merged.mp4');
}
assert.throws(() => api.uploadFileUri('relative.mp4'), /路径无效/);
console.log('PASS: original/trimmed videos, WAV and merged files use valid multipart file URIs in both capture modes');
