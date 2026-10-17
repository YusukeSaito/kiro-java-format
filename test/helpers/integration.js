'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function findInstalledExtension() {
  if (process.env.KIRO_JAVA_EXT) {
    return fs.existsSync(path.join(process.env.KIRO_JAVA_EXT, 'nbcode', 'bin')) ? process.env.KIRO_JAVA_EXT : null;
  }
  const root = path.join(os.homedir(), '.kiro', 'extensions');
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  const found = names.filter((n) => /^oracle\.oracle-java-/.test(n) && fs.existsSync(path.join(root, n, 'nbcode', 'bin')));
  return found.length > 0 ? path.join(root, found.sort().pop()) : null;
}

function hasJdk17() {
  const homes = [process.env.KIRO_JAVA_JDKHOME, process.env.JDK_HOME, process.env.JAVA_HOME].filter(Boolean);
  if (homes.some((h) => fs.existsSync(path.join(h, 'bin', 'java')))) return true;
  if (process.platform === 'darwin') {
    try {
      execFileSync('/usr/libexec/java_home', ['-v', '17+'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Why the nbcode integration tests cannot run here, or false when they can.
 * Used as node:test's `skip` option.
 */
function shouldSkipIntegration() {
  if (process.env.KJF_INTEGRATION !== '1') return 'set KJF_INTEGRATION=1 to run the nbcode integration tests';
  if (!findInstalledExtension()) return 'the Oracle Java extension (nbcode) is not installed';
  if (!hasJdk17()) return 'no JDK 17+ found';
  return false;
}

module.exports = { shouldSkipIntegration, findInstalledExtension };
