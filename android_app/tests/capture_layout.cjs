const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../captureLayout.ts'), 'utf8');
const out = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: out });
for (const [width, height, landscape] of [
  [360, 520, false], [320, 320, false], [800, 180, true],
  [720, 230, true], [500, 140, true], [320, 90, true],
]) {
  const size = out.getCapturePreviewSize(width, height, landscape);
  assert(size.width <= width - 28 && size.height <= height - 28, 'Preview must fit the measured usable region');
  assert(size.height <= (landscape ? 190 : 300), 'Preview must stay compact');
  assert(Math.abs(size.width / size.height - (landscape ? 16 / 9 : 9 / 16)) < 0.00001, 'Keep the camera aspect ratio');
  if (landscape) assert(width - size.width - 44 > 150, 'Leave room for recording controls');
}
console.log('PASS: portrait/landscape, short viewports, proportions and control space');
