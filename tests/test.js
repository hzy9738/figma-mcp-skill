import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 动态导入模块
const utils = await import(resolve(__dirname, '../src/utils.js'));
const { CacheManager, findCacheRoot } = await import(resolve(__dirname, '../src/cache.js'));

// ---------------------------------------------------------------------------
// URL 解析测试
// ---------------------------------------------------------------------------

test('parseFigmaUrl - 完整 design URL', () => {
  const { fileKey, nodeId } = utils.parseFigmaUrl(
    'https://www.figma.com/design/ABC123/MyFile?node-id=1-2',
  );
  assert.equal(fileKey, 'ABC123');
  assert.equal(nodeId, '1:2');
});

test('parseFigmaUrl - file URL 无 node-id', () => {
  const { fileKey, nodeId } = utils.parseFigmaUrl(
    'https://www.figma.com/file/XYZ789/Project',
  );
  assert.equal(fileKey, 'XYZ789');
  assert.equal(nodeId, null);
});

test('parseFigmaUrl - 纯 file_key', () => {
  const { fileKey, nodeId } = utils.parseFigmaUrl('ABC123');
  assert.equal(fileKey, 'ABC123');
  assert.equal(nodeId, null);
});

test('parseFigmaUrl - node_id 格式', () => {
  const { fileKey, nodeId } = utils.parseFigmaUrl('1:2');
  assert.equal(fileKey, '1:2');
  assert.equal(nodeId, null);
});

test('parseFigmaUrl - proto URL', () => {
  const { fileKey, nodeId } = utils.parseFigmaUrl(
    'https://www.figma.com/proto/ABC123/Prototype?node-id=3-4',
  );
  assert.equal(fileKey, 'ABC123');
  assert.equal(nodeId, '3:4');
});

test('parseFigmaUrl - node-id 含横线', () => {
  const { fileKey, nodeId } = utils.parseFigmaUrl(
    'https://www.figma.com/design/ABC123/File?node-id=100-200',
  );
  assert.equal(fileKey, 'ABC123');
  assert.equal(nodeId, '100:200');
});

test('parseFigmaUrl - 非法 URL', () => {
  assert.throws(() => utils.parseFigmaUrl('https://google.com/not-figma'), utils.ToolError);
});

// ---------------------------------------------------------------------------
// 后端解析测试
// ---------------------------------------------------------------------------

test('resolveBackend - 显式 remote', () => {
  const backend = utils.resolveBackend('remote', false);
  assert.equal(backend, 'remote');
});

test('resolveBackend - 显式 desktop', () => {
  const backend = utils.resolveBackend('desktop', false);
  assert.equal(backend, 'desktop');
});

test('resolveBackend - 非法值', () => {
  assert.throws(() => utils.resolveBackend('invalid', false), utils.ToolError);
});

// ---------------------------------------------------------------------------
// 参数解析测试
// ---------------------------------------------------------------------------

test('parseGlobalArgs - 默认 status', () => {
  const g = utils.parseGlobalArgs([]);
  assert.equal(g.command, 'status');
  assert.equal(g.debug, false);
});

test('parseGlobalArgs - 指定命令', () => {
  const g = utils.parseGlobalArgs(['get-design', '--node-id', '1:2', 'ABC123']);
  assert.equal(g.command, 'get-design');
  assert.deepEqual(g.cmdArgs, ['--node-id', '1:2', 'ABC123']);
});

test('parseGlobalArgs - --backend + --debug', () => {
  const g = utils.parseGlobalArgs(['--backend', 'remote', '--debug', 'status', '--json']);
  assert.equal(g.backend, 'remote');
  assert.equal(g.debug, true);
  assert.equal(g.command, 'status');
  assert.deepEqual(g.cmdArgs, ['--json']);
});

test('parseCmdArgs - boolean + string + positional', () => {
  const { opts, positional } = utils.parseCmdArgs(
    ['--json', '--node-id', '1:2', 'ABC123'],
    { '--json': 'boolean', '--node-id': 'string' },
  );
  assert.equal(opts.json, true);
  assert.equal(opts.nodeId, '1:2');
  assert.deepEqual(positional, ['ABC123']);
});

test('parseCmdArgs - array 选项', () => {
  const { opts } = utils.parseCmdArgs(
    ['--client-languages', 'typescript', 'css', '--json'],
    { '--client-languages': 'array', '--json': 'boolean' },
  );
  assert.deepEqual(opts.clientLanguages, ['typescript', 'css']);
  assert.equal(opts.json, true);
});

// ---------------------------------------------------------------------------
// resolveFileAndNode 测试
// ---------------------------------------------------------------------------

test('resolveFileAndNode - URL + node-id', () => {
  const { fileKey, nodeId } = utils.resolveFileAndNode(
    { nodeId: null, fileKey: null },
    ['https://www.figma.com/design/ABC123/X?node-id=1-2'],
  );
  assert.equal(fileKey, 'ABC123');
  assert.equal(nodeId, '1:2');
});

test('resolveFileAndNode - --file-key + --node-id 无 url', () => {
  const { fileKey, nodeId } = utils.resolveFileAndNode(
    { nodeId: '1:2', fileKey: 'ABC123' },
    [],
  );
  assert.equal(fileKey, 'ABC123');
  assert.equal(nodeId, '1:2');
});

test('resolveFileAndNode - 缺少参数报错', () => {
  assert.throws(
    () => utils.resolveFileAndNode({ nodeId: null, fileKey: null }, []),
    utils.ToolError,
  );
});

// ---------------------------------------------------------------------------
// 缓存测试
// ---------------------------------------------------------------------------

test('CacheManager - 写入和读取', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmp = mkdtempSync(join(tmpdir(), 'figma-test-'));
  try {
    const cache = new CacheManager(tmp);
    cache.write('FILE001', 'get_design_context', { key: 'value' }, '1:2');
    const cached = cache.read('FILE001', 'get_design_context', '1:2');
    assert.ok(cached !== null);
    assert.equal(cached.file_key, 'FILE001');
    assert.equal(cached.tool, 'get_design_context');
    assert.deepEqual(cached.data, { key: 'value' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CacheManager - 清除', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmp = mkdtempSync(join(tmpdir(), 'figma-test-'));
  try {
    const cache = new CacheManager(tmp);
    cache.write('FILE001', 'get_design_context', { x: 1 });
    cache.write('FILE002', 'get_metadata', { y: 2 });
    const count = cache.clear('FILE001');
    assert.equal(count, 1);
    assert.equal(cache.read('FILE001', 'get_design_context'), null);
    assert.ok(cache.read('FILE002', 'get_metadata') !== null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
