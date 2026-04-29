import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

import { CACHE_DIRNAME } from './utils.js';

/** 查找项目缓存根目录：<project>/.figma/ */
export function findCacheRoot() {
  try {
    const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (top) return resolve(top, CACHE_DIRNAME);
  } catch { /* 非 git 仓库，用当前目录 */ }
  return resolve(process.cwd(), CACHE_DIRNAME);
}

export class CacheManager {
  constructor(cacheRoot) {
    this.cacheRoot = cacheRoot;
  }

  fileCacheDir(fileKey) {
    return resolve(this.cacheRoot, fileKey);
  }

  cachePath(fileKey, toolName, nodeId = null) {
    const dir = this.fileCacheDir(fileKey);
    mkdirSync(dir, { recursive: true });
    const safeNode = nodeId ? nodeId.replace(/:/g, '_') : null;
    const name = safeNode ? `${toolName}_${safeNode}.json` : `${toolName}.json`;
    return resolve(dir, name);
  }

  read(fileKey, toolName, nodeId = null) {
    const p = this.cachePath(fileKey, toolName, nodeId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  write(fileKey, toolName, data, nodeId = null) {
    const p = this.cachePath(fileKey, toolName, nodeId);
    const payload = {
      cached_at: new Date().toISOString(),
      file_key: fileKey,
      tool: toolName,
      node_id: nodeId,
      data,
    };
    writeFileSync(p, JSON.stringify(payload, null, 2), 'utf-8');
    return p;
  }

  clear(fileKey = null) {
    let count = 0;
    if (fileKey) {
      const dir = this.fileCacheDir(fileKey);
      if (existsSync(dir)) {
        count = readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.json')).length;
        rmSync(dir, { recursive: true, force: true });
      }
    } else if (existsSync(this.cacheRoot)) {
      try {
        count = readdirSync(this.cacheRoot, { recursive: true }).filter(f => f.endsWith('.json')).length;
      } catch { /* ignore */ }
      rmSync(this.cacheRoot, { recursive: true, force: true });
    }
    return count;
  }

  cacheInfo() {
    const info = { root: String(this.cacheRoot), files: {} };
    if (!existsSync(this.cacheRoot)) return info;
    try {
      for (const entry of readdirSync(this.cacheRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const items = readdirSync(resolve(this.cacheRoot, entry.name))
            .filter(f => f.endsWith('.json'));
          if (items.length) info.files[entry.name] = items;
        }
      }
    } catch { /* ignore */ }
    return info;
  }
}
