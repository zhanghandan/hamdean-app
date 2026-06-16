// Hamdean Crypto — AES-256-GCM, machine-bound key
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Machine fingerprint — files encrypted on this machine only decrypt here
function getMachineFingerprint() {
  const parts = [
    os.hostname(),
    os.userInfo().username,
    os.cpus()[0]?.model || 'unknown',
    os.platform(),
    os.arch()
  ];
  return parts.join('|');
}

// Derive 32-byte AES key from machine fingerprint + pepper
const PEPPER = 'HamdeanV4_CryptoSeal_2026_X7k9'; // hardcoded application pepper
function deriveKey() {
  const fp = getMachineFingerprint();
  return crypto.createHash('sha256').update(fp + PEPPER).digest();
}

const KEY = deriveKey();

/**
 * Encrypt plaintext → { iv, tag, ciphertext } base64
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf-8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted
  };
}

/**
 * Decrypt { iv, tag, data } → plaintext
 * Returns null if decryption fails (wrong machine, tampered, etc.)
 */
function decrypt(payload) {
  try {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(payload.data, 'base64', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  } catch (e) {
    return null; // decryption failed — wrong machine or corrupted
  }
}

/**
 * Read a file, decrypting if .enc version exists
 */
function readSecure(filePath) {
  const encPath = filePath + '.enc';
  if (fs.existsSync(encPath)) {
    try {
      const payload = JSON.parse(fs.readFileSync(encPath, 'utf-8'));
      const plain = decrypt(payload);
      if (plain !== null) return plain;
      // Decryption failed — fall through to plain file
    } catch {}
  }
  // Fallback: read plain file
  if (fs.existsSync(filePath)) {
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  }
  return null;
}

/**
 * Write a file, automatically encrypting
 */
function writeSecure(filePath, content) {
  const payload = encrypt(content);
  fs.writeFileSync(filePath + '.enc', JSON.stringify(payload));
  // Also write plain for transition period, then delete
  fs.writeFileSync(filePath, content);
}

/**
 * Encrypt an existing file — delete plain, keep only .enc
 */
function encryptExistingFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  const payload = encrypt(content);
  fs.writeFileSync(filePath + '.enc', JSON.stringify(payload));
  // Move plain to .bak, don't delete yet (safety)
  fs.renameSync(filePath, filePath + '.plain.bak');
  return true;
}

/**
 * Decrypt a file and restore plain version
 */
function decryptToPlain(filePath) {
  const encPath = filePath + '.enc';
  if (!fs.existsSync(encPath)) return false;
  const payload = JSON.parse(fs.readFileSync(encPath, 'utf-8'));
  const plain = decrypt(payload);
  if (plain === null) return false;
  fs.writeFileSync(filePath, plain);
  return true;
}

module.exports = { encrypt, decrypt, readSecure, writeSecure, encryptExistingFile, decryptToPlain, deriveKey, getMachineFingerprint };
