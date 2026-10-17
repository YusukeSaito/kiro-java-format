'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  applyEdits,
  fullRange,
  editsForUri,
  sameUri,
  lineStarts,
  normalizeLineEndings,
  validateEditsWithinText,
  EditsMismatchError,
} = require('../../format-java.js');

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

test('editsForUri reads only `documentChanges` when the edit carries both shapes', () => {
  const uri = 'file:///p/A.java';
  const e1 = edit(0, 0, 0, 1, 'x');
  const out = editsForUri(
    { changes: { [uri]: [e1] }, documentChanges: [{ textDocument: { uri, version: 1 }, edits: [e1] }] },
    uri
  );
  assert.deepStrictEqual(out, [e1]);
});

test('normalizeLineEndings turns CRLF and lone CR into LF', () => {
  assert.strictEqual(normalizeLineEndings('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.strictEqual(normalizeLineEndings('plain'), 'plain');
});

test('validateEditsWithinText accepts positions inside the text, at line ends and at EOF', () => {
  const text = 'ab\ncde\n';
  // lines: "ab" (2), "cde" (3), "" (0); EOF is {3,0}
  assert.doesNotThrow(() =>
    validateEditsWithinText(text, [
      edit(0, 0, 0, 2, 'x'),
      edit(1, 3, 2, 0, ''),
      edit(3, 0, 3, 0, '\n'),
    ])
  );
  assert.doesNotThrow(() => validateEditsWithinText(text, null));
  assert.doesNotThrow(() => validateEditsWithinText(text, []));
});

test('validateEditsWithinText rejects a line or character outside the text', () => {
  const text = 'ab\ncde\n';
  assert.throws(() => validateEditsWithinText(text, [edit(0, 3, 0, 3, 'x')]), EditsMismatchError);
  assert.throws(() => validateEditsWithinText(text, [edit(2, 1, 2, 1, 'x')]), EditsMismatchError);
  assert.throws(() => validateEditsWithinText(text, [edit(3, 1, 3, 1, 'x')]), EditsMismatchError);
  assert.throws(() => validateEditsWithinText(text, [edit(4, 0, 4, 0, 'x')]), EditsMismatchError);
  assert.throws(() => validateEditsWithinText(text, [{ newText: 'x' }]), EditsMismatchError);
  assert.throws(
    () => validateEditsWithinText(text, [edit(0, 0, 0, 1, 'x')].concat([edit(1, 4, 1, 4, 'y')])),
    /the language server returned edits that do not match the file; not written/
  );
});

test('validateEditsWithinText counts a CR as part of the line', () => {
  const text = 'ab\r\ncd';
  assert.doesNotThrow(() => validateEditsWithinText(text, [edit(0, 3, 0, 3, 'x')]));
  assert.throws(() => validateEditsWithinText(text, [edit(0, 4, 0, 4, 'x')]), EditsMismatchError);
});

test('editsForUri returns nothing for a missing edit', () => {
  assert.deepStrictEqual(editsForUri(null, 'file:///p/A.java'), []);
  assert.deepStrictEqual(editsForUri({}, 'file:///p/A.java'), []);
});
