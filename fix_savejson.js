// Fix: saveJSON no longer writes plain version for sensitive files
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, 'main.js');
let c = fs.readFileSync(MAIN, 'utf-8');
const original = c;

// Replace: remove fs.writeFileSync for sensitive files, add return
const old = `function saveJSON(fp, obj) {
  const json = JSON.stringify(obj, null, 2);
  const sensitiveFiles = [USERS_FILE, SESSIONS_FILE, path.join(DATA_DIR, 'config.json')];
  if (sensitiveFiles.includes(fp)) {
    writeSecure(fp, json);
  }
  fs.writeFileSync(fp, json);
}`;

const replacement = `function saveJSON(fp, obj) {
  const json = JSON.stringify(obj, null, 2);
  const sensitiveFiles = [USERS_FILE, SESSIONS_FILE, path.join(DATA_DIR, 'config.json')];
  if (sensitiveFiles.includes(fp)) {
    writeSecure(fp, json);
    return;
  }
  fs.writeFileSync(fp, json);
}`;

if (c.includes(old)) {
  c = c.replace(old, replacement);
  fs.writeFileSync(MAIN, c);
  console.log('FIXED: saveJSON now skips plain write for sensitive files');
} else if (c.includes('writeSecure(fp, json);\n    return;')) {
  console.log('ALREADY FIXED');
} else {
  // Try fuzzy: find writeSecure and add return after it
  const idx = c.indexOf('writeSecure(fp, json)');
  if (idx > 0) {
    // Find the line end after writeSecure
    const afterWrite = c.indexOf('\n', idx);
    const nextLineEnd = c.indexOf('\n', afterWrite + 1);
    if (c.slice(afterWrite, nextLineEnd).includes('fs.writeFileSync')) {
      c = c.slice(0, afterWrite + 1) + '    return;\n' + c.slice(afterWrite + 1);
      fs.writeFileSync(MAIN, c);
      console.log('FIXED via fuzzy match');
    } else {
      console.log('FAILED: unexpected structure after writeSecure');
    }
  } else {
    console.log('FAILED: writeSecure not found');
  }
}
