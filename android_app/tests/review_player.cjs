// Exercise the real component handlers with native playback and hook boundaries mocked.
// Run: node data_collection/android_app/tests/review_player.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

let hooks = [], cursor = 0, effects = [], timers = new Map(), nextTimer = 1;
const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const react = {
  useState(value) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof value === 'function' ? value() : value;
    return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
  },
  useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
  useMemo(fn, deps) {
    const i = cursor++;
    if (!hooks[i] || !equal(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() };
    return hooks[i].value;
  },
  useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
  useEffect(fn, deps) {
    const i = cursor++;
    if (!hooks[i] || !equal(hooks[i].deps, deps)) {
      const old = hooks[i]; hooks[i] = { deps };
      effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = fn(); });
    }
  },
};
const jsx = (type, props) => ({ type, props });
const calls = [];
const native = {
  Video: 'Video', ResizeMode: { CONTAIN: 'contain' },
  Audio: { async setAudioModeAsync() { calls.push('audio-mode'); } },
};
const exportsObject = {};
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../ReviewMediaPlayer.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
vm.runInNewContext(code, {
  exports: exportsObject,
  require(name) {
    if (name === 'react') return { __esModule: true, default: react, ...react };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'expo-av') return native;
    if (name === 'react-native') return { ActivityIndicator: 'Spinner', Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: x => x } };
    throw new Error(name);
  },
  setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
});
const loaded = { isLoaded: true, isPlaying: false, positionMillis: 0, durationMillis: 3000, didJustFinish: false };
let status = { isLoaded: false };
const player = {
  async getStatusAsync() { return status; },
  async playAsync() { calls.push('play'); status = { ...loaded, isPlaying: true }; },
  async pauseAsync() { calls.push('pause'); status = { ...loaded }; },
  async setPositionAsync(ms) { calls.push(`position:${ms}`); },
};
const props = { uri: 'http://test/merged.mp4', token: 'test', label: 'test', playerRef: { current: player },
  beforePlay: async () => { calls.push('pause-other'); }, onUnavailable: () => calls.push('fallback') };
let tree;
function render() {
  cursor = 0;
  tree = exportsObject.ReviewMediaPlayer(props);
  const pending = effects; effects = []; pending.forEach(fn => fn());
  return tree;
}
function nodes(node, type) {
  if (!node || typeof node !== 'object') return [];
  const children = [node.props?.children].flat(Infinity);
  return [...(node.type === type ? [node] : []), ...children.flatMap(child => nodes(child, type))];
}
const video = () => nodes(tree, 'Video')[0];
const button = i => nodes(tree, 'Pressable')[i];
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  render();
  const stableSource = video().props.source;
  button(0).props.onPress(); await settle(); render();
  assert(!calls.includes('play'), 'Do not play until media is loaded');
  status = { ...loaded };
  video().props.onLoad(status); await settle(); render();
  assert(calls.includes('play'), 'A click during loading must start after onLoad');
  assert(calls.indexOf('pause-other') < calls.indexOf('play'), 'Pause the other track before playing');
  assert.equal(video().props.source, stableSource, 'Progress/button updates must retain the source');

  calls.length = 0;
  button(0).props.onPress(); await settle(); render();
  assert(calls.includes('pause'), 'Playing media must pause');
  status = { ...loaded, positionMillis: 3000, didJustFinish: true };
  calls.length = 0;
  button(0).props.onPress(); await settle(); render();
  assert(calls.includes('position:0') && calls.includes('play'), 'Finished media must restart from zero');

  calls.length = 0;
  video().props.onError('Network failed'); render();
  assert(calls.includes('fallback'), 'Failed merged media must notify fallback');
  button(2).props.onPress(); render(); render();
  assert(nodes(tree, 'Text').some(x => String(x.props.children).includes('正在加载')), 'Retry must show loading');
  [...timers.values()].forEach(fn => fn()); render();
  assert(nodes(tree, 'Text').some(x => String(x.props.children).includes('加载超时')), 'Timeout must expose a retryable error');
  player.getStatusAsync = () => new Promise(() => {});
  button(0).props.onPress(); await settle(); render();
  assert.equal(button(0).props.disabled, true);
  [...timers.values()].forEach(fn => fn()); await settle(); render();
  assert.equal(button(0).props.disabled, false, 'An unresponsive native command must not disable controls forever');
  assert(nodes(tree, 'Text').some(x => String(x.props.children).includes('播放操作超时')));
  console.log('PASS: queued play, track focus, stable source, pause, replay, fallback, retry, loading timeout and native-command timeout');
})().catch(error => { console.error(error); process.exitCode = 1; });
