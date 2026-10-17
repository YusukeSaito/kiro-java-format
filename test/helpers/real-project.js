'use strict';

/*
 * A copy of a real (Lombok) Maven project for the acceptance runs. The project
 * path comes from KJF_REAL_PROJECT; nothing about it is stored in the repo.
 * The original is only read.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COPIED = ['pom.xml', 'nb-configuration.xml', 'lombok.config', '.mvn', path.join('src', 'main', 'java')];
const FILE_COUNT = 20;

function listJavaFiles(dir) {
  const out = [];
  const walk = (cur) => {
    for (const name of fs.readdirSync(cur)) {
      const p = path.join(cur, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.java')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Pick FILE_COUNT files deterministically: files using @Slf4j and `log.`
 * without text blocks, sorted by path, every floor(N / FILE_COUNT)-th one.
 * They never resolve under nbcode (the Lombok members stay unknown), so
 * organizing is always skipped and the golden does not depend on timing.
 */
function selectRealProjectFiles(projectDir) {
  const javaRoot = path.join(projectDir, 'src', 'main', 'java');
  const candidates = listJavaFiles(javaRoot)
    .filter((p) => {
      const text = fs.readFileSync(p, 'utf8');
      return text.includes('@Slf4j') && text.includes('log.') && !text.includes('"""');
    })
    .map((p) => path.relative(projectDir, p))
    .sort();
  const step = Math.max(1, Math.floor(candidates.length / FILE_COUNT));
  const picked = [];
  for (let i = 0; i < candidates.length && picked.length < FILE_COUNT; i += step) picked.push(candidates[i]);
  return picked;
}

/**
 * Indent every body line after the last import by three more spaces, except
 * lines holding a string literal, so the formatter has work to do without the
 * meaning of the code changing.
 */
function disturbIndentation(text) {
  const lines = text.split('\n');
  let lastImport = -1;
  lines.forEach((l, i) => {
    if (/^import\s/.test(l)) lastImport = i;
  });
  return lines.map((l, i) => (i > lastImport && /^\s/.test(l) && !l.includes('"') ? '   ' + l : l)).join('\n');
}

/** Copy the parts of the project the language server needs, then disturb the picked files. */
function prepareRealProjectBase(projectDir, baseDir) {
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });
  for (const rel of COPIED) {
    const src = path.join(projectDir, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(baseDir, rel), { recursive: true });
  }
  const files = selectRealProjectFiles(baseDir);
  for (const rel of files) {
    const p = path.join(baseDir, rel);
    fs.writeFileSync(p, disturbIndentation(fs.readFileSync(p, 'utf8')));
  }
  return { files };
}

/** A digest of what the golden depends on: the build files and the picked sources. */
function hashRealProjectBase(baseDir, files) {
  const hash = crypto.createHash('sha256');
  for (const rel of ['pom.xml', 'nb-configuration.xml', 'lombok.config', ...files]) {
    const p = path.join(baseDir, rel);
    hash.update(rel);
    hash.update('\0');
    if (fs.existsSync(p)) hash.update(fs.readFileSync(p));
    hash.update('\0');
  }
  return hash.digest('hex');
}

module.exports = { selectRealProjectFiles, prepareRealProjectBase, hashRealProjectBase, disturbIndentation };
