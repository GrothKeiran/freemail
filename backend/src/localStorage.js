import fs from 'node:fs/promises';
import path from 'node:path';

function safeMailbox(mailbox = 'unknown') {
  return String(mailbox).toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
}

export class LocalStorageManager {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  async ensureReady() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  buildKey(mailbox, extension = 'eml') {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    const rand = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return `${y}/${m}/${d}/${safeMailbox(mailbox)}/${hh}${mm}${ss}-${rand}.${extension}`;
  }

  resolve(key) {
    return path.join(this.rootDir, key);
  }

  async write(key, data) {
    const fullPath = this.resolve(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
    return fullPath;
  }

  async read(key) {
    const fullPath = this.resolve(key);
    return await fs.readFile(fullPath);
  }

  async exists(key) {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}
