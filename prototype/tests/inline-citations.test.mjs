import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { citationReference, splitCitationRuns } from '../src/inline-citations.js';

function renderCitations(text, refs = []) {
  const cells = [], opened = [];
  let cursor = 0, tree;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useId: () => 'citation-test',
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = initial;
      return [cells[index], update => { cells[index] = typeof update === 'function' ? update(cells[index]) : update; }];
    },
  };
  const source = readFileSync(new URL('../src/InlineCitations.jsx', import.meta.url), 'utf8');
  const code = transformSync(source.replace(/^import .*;\r?\n/gm, '').replace('export default function', 'function'), { loader: 'jsx', format: 'cjs' }).code;
  const Component = vm.runInNewContext(`${code}\nInlineCitations`, { React, ...React, citationReference, splitCitationRuns });
  const render = () => { cursor = 0; tree = Component({ text, refs, onReference: ref => opened.push(ref) }); };
  function nodes(value, includeHidden = false) {
    if (value == null || typeof value === 'boolean') return [];
    if (Array.isArray(value)) return value.flatMap(item => nodes(item, includeHidden));
    if (typeof value !== 'object') return [value];
    if (value.props.hidden && !includeHidden) return [];
    return [value, ...nodes(value.props.children, includeHidden)];
  }
  const content = value => nodes(value).filter(item => typeof item === 'string' || typeof item === 'number').join('');
  render();
  return {
    opened, text: () => content(tree),
    all: () => nodes(tree, true),
    buttons: () => nodes(tree).filter(item => item.type === 'button'),
    click(label) {
      const button = nodes(tree).find(item => item.type === 'button' && content(item) === label);
      assert.ok(button, `Missing ${label}`); button.props.onClick(); render();
    },
  };
}

test('citation runs retain exact prose, whitespace, numbers and separate paragraphs', () => {
  const text = '事实 [1][2][21]。短引用 [22] \t[23]；单项 [8]。\n[4]\n[5]，普通 [abc]。';
  const parts = splitCitationRuns(text);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.numbers).map(part => part.numbers), [['1', '2', '21'], ['22', '23']]);
  assert.deepEqual(splitCitationRuns('普通正文 [1] 与 [abc]'), [{ text: '普通正文 [1] 与 [abc]' }]);
});

test('long and two-source runs start collapsed while single citations stay visible', () => {
  const longRun = Array.from({ length: 21 }, (_, index) => `[${index + 1}]`).join('');
  const ui = renderCitations(`核算事实 ${longRun}。盘中时点 [22][23]。检查项 [21]。`);
  assert.equal(ui.text(), '核算事实 21 条来源。盘中时点 2 条来源。检查项 [21]。');
  for (const button of ui.buttons()) {
    assert.equal(button.props.type, 'button');
    assert.equal(button.props['aria-expanded'], false);
    assert.ok(ui.all().some(node => node.props?.id === button.props['aria-controls'] && node.props.hidden));
  }
  ui.click('2 条来源');
  assert.equal(ui.text(), '核算事实 21 条来源。盘中时点 收起来源[22][23]。检查项 [21]。');
  assert.equal(ui.buttons().find(button => button.props['aria-expanded'] === true)?.props.type, 'button');
  ui.click('收起来源');
  assert.equal(ui.text(), '核算事实 21 条来源。盘中时点 2 条来源。检查项 [21]。');
});

test('expanded citation uses original numbered mapping even when references are reordered', () => {
  const refs = Object.freeze([
    Object.freeze({ label: '[23] 当根截至决策时点', evidenceId: 'partial-bar', tradeId: 'T18', panel: 'evidence' }),
    Object.freeze({ label: '[22] 决策前完整 K 线', evidenceId: 'complete-bar', tradeId: 'T18', panel: 'evidence' }),
  ]);
  const ui = renderCitations('根据材料 [22][23]。', refs);
  assert.equal(ui.opened.length, 0);
  ui.click('2 条来源'); ui.click('[22]'); ui.click('[23]');
  assert.equal(ui.opened[0], refs[1]);
  assert.equal(ui.opened[1], refs[0]);
  assert.deepEqual(ui.buttons().filter(button => button.props['aria-label']).map(button => button.props['aria-label']), refs.toReversed().map(ref => ref.label));
  ui.click('收起来源');
  assert.equal(ui.buttons().length, 1);
});

test('unknown citation numbers remain readable after expansion without inventing a destination', () => {
  const ui = renderCitations('历史回复 [3][99]。', [{ label: '[3] 成交记录', evidenceId: 'trade-3' }]);
  ui.click('2 条来源');
  assert.equal(ui.text(), '历史回复 收起来源[3][99]。');
  assert.equal(ui.buttons().length, 2);
  assert.equal(citationReference([{ label: '第 99 笔' }], '99'), undefined);
});
