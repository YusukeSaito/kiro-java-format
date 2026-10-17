'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyEdits, fullRange, editsForUri, sameUri, lineStarts } = require('../../format-java.js');

const edit = (sl, sc, el, ec, newText) => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText,
});

test('lineStarts lists the offset of every line', () => {
  assert.deepStrictEqual(lineStarts('a\nbc\n'), [0, 2, 5]);
  assert.deepStrictEqual(lineStarts(''), [0]);
});

test('applyEdits applies edits from the end so earlier offsets stay valid', () => {
  const text = 'class A {\n  int x;\n}\n';
  const out = applyEdits(text, [edit(0, 0, 0, 5, 'final class'), edit(1, 0, 1, 2, '    ')]);
  assert.strictEqual(out, 'final class A {\n    int x;\n}\n');
});

test('applyEdits clamps a position past the last line to the end of the text', () => {
  assert.strictEqual(applyEdits('ab', [edit(5, 0, 5, 0, '!')]), 'ab!');
});

test('fullRange spans the whole text', () => {
  assert.deepStrictEqual(fullRange('a\nbc'), { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } });
  assert.deepStrictEqual(fullRange('a\n'), { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } });
  assert.deepStrictEqual(fullRange(''), { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
});

test('sameUri matches differently percent-encoded forms of one path', () => {
  assert.ok(sameUri('file:///tmp/a%20b/X.java', 'file:///tmp/a b/X.java'));
  assert.ok(!sameUri('file:///tmp/a/X.java', 'file:///tmp/a/Y.java'));
});

test('editsForUri reads `changes` and keeps only the edits for the document', () => {
  const uri = 'file:///p/A.java';
  const e1 = edit(0, 0, 0, 1, 'x');
  const out = editsForUri({ changes: { [uri]: [e1], 'file:///p/B.java': [edit(1, 0, 1, 0, 'y')] } }, uri);
  assert.deepStrictEqual(out, [e1]);
});

test('editsForUri reads `documentChanges` and keeps only the edits for the document', () => {
  const uri = 'file:///p/A.java';
  const e1 = edit(0, 0, 0, 1, 'x');
  const out = editsForUri(
    {
      documentChanges: [
        { textDocument: { uri: 'file:///p/B.java', version: 1 }, edits: [edit(1, 0, 1, 0, 'y')] },
        { textDocument: { uri, version: 1 }, edits: [e1] },
      ],
    },
    uri
  );
  assert.deepStrictEqual(out, [e1]);
});

test('editsForUri returns nothing for a missing edit', () => {
  assert.deepStrictEqual(editsForUri(null, 'file:///p/A.java'), []);
  assert.deepStrictEqual(editsForUri({}, 'file:///p/A.java'), []);
});
