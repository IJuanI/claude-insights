import * as fs from 'fs';
import * as path from 'path';
import { PERM_DIR, PermissionRequest } from './types';

/** Ensure the permission directory exists */
export function ensurePermDir(log: { appendLine(msg: string): void }): void {
  try {
    if (!fs.existsSync(PERM_DIR)) {
      fs.mkdirSync(PERM_DIR, { recursive: true });
    }
  } catch (e) {
    log.appendLine(`[PermProxy] Failed to create ${PERM_DIR}: ${e}`);
  }
}

/** Read and parse a request file, returning null on failure */
export function readRequestFile(filePath: string): PermissionRequest | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write a decision file atomically (tmp + rename) */
export function writeDecision(uuid: string, decision: string, log: { appendLine(msg: string): void }): void {
  const decFile = path.join(PERM_DIR, `dec-${uuid}.json`);
  const tmpFile = path.join(PERM_DIR, `.dec-${uuid}.tmp`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({ decision }));
    fs.renameSync(tmpFile, decFile);
  } catch (e) {
    log.appendLine(`[PermProxy] Failed to write decision: ${e}`);
  }
}

/** List all files in PERM_DIR, returning empty array on failure */
export function listPermDir(): string[] {
  try {
    return fs.readdirSync(PERM_DIR);
  } catch {
    return [];
  }
}

/** Clean up request files on dispose */
export function cleanupReqFiles(): void {
  try {
    const files = fs.readdirSync(PERM_DIR).filter(f => f.startsWith('req-'));
    for (const f of files) {
      try { fs.unlinkSync(path.join(PERM_DIR, f)); } catch {}
    }
  } catch {}
}
