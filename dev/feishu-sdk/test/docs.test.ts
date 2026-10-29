import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuAuth } from '../src/auth.ts';
import { main } from '../src/cli.ts';
import { REQUIRED_SCOPES } from '../src/config.ts';
import { parseLink } from '../src/docs.ts';
import { docxToMarkdown } from '../src/markdown.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';
import { tempDir } from './helpers/tmp.ts';

type Obj = Record<string, any>;
const run = (content: string, style: Obj = {}) => ({ text_run: { content, text_element_style: style } });
const text = (id: string, type: number, key: string, elements: Obj[], extra: Obj = {}) => ({ block_id: id, block_type: type, [key]: { elements, style: {} }, children: [], ...extra });

/** A script document as a supplier writes one: a heading, a paragraph with marks and a link, a list, a two-column table, a picture. */
const BLOCKS: Obj[] = [
  { block_id: 'page', block_type: 1, page: { elements: [run('脚本 V2')] }, children: ['h', 'p', 'l1', 'l2', 'tbl', 'img', 'hr', 'code'] },
  text('h', 3, 'heading1', [run('开场')]),
  text('p', 2, 'text', [run('全球 '), run('3 亿', { bold: true }), run('玩家，'), run('官网', { link: { url: 'https%3A%2F%2Fexample.com%2Fa' } })]),
  text('l1', 12, 'bullet', [run('镜头一')], { children: ['l1a'] }),
  text('l1a', 12, 'bullet', [run('特写')]),
  text('l2', 13, 'ordered', [run('镜头二')]),
  { block_id: 'tbl', block_type: 31, table: { cells: ['c1', 'c2', 'c3', 'c4'], property: { row_size: 2, column_size: 2 } }, children: ['c1', 'c2', 'c3', 'c4'] },
  { block_id: 'c1', block_type: 32, table_cell: {}, children: ['t1'] }, text('t1', 2, 'text', [run('画面')]),
  { block_id: 'c2', block_type: 32, table_cell: {}, children: ['t2'] }, text('t2', 2, 'text', [run('口播')]),
  { block_id: 'c3', block_type: 32, table_cell: {}, children: ['t3'] }, text('t3', 2, 'text', [run('冰原|远景')]),
  { block_id: 'c4', block_type: 32, table_cell: {}, children: ['t4', 't5'] }, text('t4', 2, 'text', [run('不用氪金')]), text('t5', 2, 'text', [run('也能玩')]),
  { block_id: 'img', block_type: 27, image: { token: 'imgtoken' }, children: [] },
  { block_id: 'hr', block_type: 22, divider: {}, children: [] },
  text('code', 14, 'code', [run('a = 1\nb = 2')]),
];

test('a docx becomes Markdown that keeps its text and structure', () => {
  assert.equal(docxToMarkdown(BLOCKS), [
    '# 脚本 V2', '', '# 开场', '', '全球 **3 亿**玩家，[官网](https://example.com/a)', '', '- 镜头一', '  - 特写', '1. 镜头二', '',
    '| 画面 | 口播 |', '| --- | --- |', '| 冰原\\|远景 | 不用氪金<br>也能玩 |', '', '[图片]', '', '---', '', '```', 'a = 1', 'b = 2', '```', '',
  ].join('\n'));
});

test('only Feishu document links are read, and an old-style doc is named as such', () => {
  assert.deepEqual(parseLink('https://centurygames.feishu.cn/wiki/CSy2dZ3XvoLDmBxolPXcNbtunuc'), { kind: 'wiki', token: 'CSy2dZ3XvoLDmBxolPXcNbtunuc', sheet: null });
  assert.deepEqual(parseLink('https://x.feishu.cn/sheets/shtABCDEFGH?sheet=abc'), { kind: 'sheets', token: 'shtABCDEFGH', sheet: 'abc' });
  for (const bad of ['http://x.feishu.cn/docx/ABCDEFGH', 'https://feishu.cn.evil.com/docx/ABCDEFGH', 'https://x.feishu.cn/file/ABCDEFGH', 'nope']) assert.throws(() => parseLink(bad), bad);
  assert.throws(() => parseLink('https://x.feishu.cn/docs/ABCDEFGH'), /旧版文档/);
});

async function loggedIn(mock: MockFeishu) {
  const dir = tempDir('fs-doc-');
  const c = clock(Date.now());
  mock.scope = [...REQUIRED_SCOPES, 'offline_access'].join(' ');
  const auth = new FeishuAuth({ paths: resolveDataPaths({ LARK_AGENT_USER_DIR: dir }), app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep });
  await auth.startLogin();
  mock.deviceScript = ['issue'];
  await auth.pollLogin(10_000);
  return { env: { LARK_AGENT_USER_DIR: dir, FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret }, endpoints: mock.endpoints };
}

test('doc fetch: a wiki node holding a docx is saved as Markdown in a new file, as the user', async () => {
  const mock = await new MockFeishu().start();
  try {
    mock.more = pathname => {
      if (pathname === '/open-apis/wiki/v2/spaces/get_node') return { node: { node_token: 'wikiNODE1', obj_type: 'docx', obj_token: 'doxABCDEFGH', title: '脚本 V2' } };
      if (pathname === '/open-apis/docx/v1/documents/doxABCDEFGH') return { document: { revision_id: 3, title: '脚本 V2' } };
      if (pathname === '/open-apis/docx/v1/documents/doxABCDEFGH/blocks') return { items: BLOCKS, has_more: false };
      return undefined;
    };
    const ctx = await loggedIn(mock);
    const output = path.join(tempDir('fs-out-'), '脚本.md');
    const saved = await main(['doc', 'fetch', '--url', 'https://centurygames.feishu.cn/wiki/wikiNODE1', '--output', output], ctx);
    assert.equal(saved.code, 0);
    assert.deepEqual([saved.result!.status, saved.result!.kind, saved.result!.title], ['saved', 'docx', '脚本 V2']);
    assert.match(fs.readFileSync(output, 'utf8'), /\| 冰原\\\|远景 \| 不用氪金<br>也能玩 \|/);
    const again = await main(['doc', 'fetch', '--url', 'https://centurygames.feishu.cn/wiki/wikiNODE1', '--output', output], ctx);
    assert.deepEqual([again.code, again.result!.status], [2, 'blocked'], 'an existing file is not overwritten');
  } finally { await mock.stop(); }
});

test('doc fetch: a sheet is saved tab by tab, the linked tab only when the link names one; without a login it says what to do', async () => {
  const mock = await new MockFeishu().start();
  try {
    const tabs = [
      { sheet_id: 's1', title: '口播', index: 0, resource_type: 'sheet', grid_properties: { row_count: 3, column_count: 2 } },
      { sheet_id: 's2', title: '分镜', index: 1, resource_type: 'sheet', grid_properties: { row_count: 2, column_count: 1 } },
      { sheet_id: 's3', title: '隐藏', index: 2, resource_type: 'sheet', hidden: true, grid_properties: { row_count: 1, column_count: 1 } },
    ];
    const values: Record<string, unknown[][]> = { s1: [['时间', '口播'], [null, null], ['00:01', [{ type: 'text', text: '零氪也能玩' }]]], s2: [['冰原']] };
    mock.more = (pathname, query) => {
      if (pathname === '/open-apis/sheets/v3/spreadsheets/shtABCDEFGH') return { spreadsheet: { title: '口播表' } };
      if (pathname === '/open-apis/sheets/v3/spreadsheets/shtABCDEFGH/sheets/query') return { sheets: tabs };
      if (pathname.endsWith('/values_batch_get')) return { valueRanges: [{ values: values[String(query.get('ranges')).split('!')[0]!] }] };
      return undefined;
    };
    const ctx = await loggedIn(mock);
    const all = path.join(tempDir('fs-out-'), 'all.md');
    const saved = await main(['doc', 'fetch', '--url', 'https://centurygames.feishu.cn/sheets/shtABCDEFGH', '--output', all], ctx);
    assert.deepEqual([saved.code, saved.result!.kind, saved.result!.tabs], [0, 'sheet', ['口播', '分镜']]);
    assert.equal(fs.readFileSync(all, 'utf8'), [
      '# 口播表', '', '## 口播', '', '| 行 | A | B |', '| --- | --- | --- |', '| 1 | 时间 | 口播 |', '| 3 | 00:01 | 零氪也能玩 |', '',
      '## 分镜', '', '| 行 | A |', '| --- | --- |', '| 1 | 冰原 |', '',
    ].join('\n'));
    const one = path.join(tempDir('fs-out-'), 'one.md');
    await main(['doc', 'fetch', '--url', 'https://centurygames.feishu.cn/sheets/shtABCDEFGH?sheet=s2', '--output', one], ctx);
    assert.doesNotMatch(fs.readFileSync(one, 'utf8'), /口播 \|/);

    const nobody = await main(['doc', 'fetch', '--url', 'https://centurygames.feishu.cn/sheets/shtABCDEFGH', '--output', path.join(tempDir('fs-out-'), 'x.md')],
      { env: { LARK_AGENT_USER_DIR: tempDir('fs-none-'), FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret }, endpoints: mock.endpoints });
    assert.deepEqual([nobody.code, nobody.result!.status], [2, 'login_required']);
    assert.match(nobody.result!.todo[0], /authorize --qr/);
  } finally { await mock.stop(); }
});

test('doc fetch: a document the account may not read is said to be so, and a missing tab names the tabs there are', async () => {
  const mock = await new MockFeishu().start();
  try {
    mock.more = pathname => {
      if (pathname === '/open-apis/sheets/v3/spreadsheets/shtABCDEFGH') return { spreadsheet: { title: '表' } };
      if (pathname === '/open-apis/sheets/v3/spreadsheets/shtABCDEFGH/sheets/query') return { sheets: [{ sheet_id: 's1', title: '口播', index: 0, resource_type: 'sheet' }] };
      return undefined;
    };
    const ctx = await loggedIn(mock);
    const tab = await main(['doc', 'fetch', '--url', 'https://centurygames.feishu.cn/sheets/shtABCDEFGH', '--sheet', '分镜', '--output', path.join(tempDir('fs-out-'), 'x.md')], ctx);
    assert.match(tab.result!.reason, /没有工作表“分镜”；有：口播/);
    // The real answer for a docx the account may not read (2026-10-29): HTTP 403, code 1770032, "forBidden".
    const forbidden = await main(['doc', 'fetch', '--url', 'https://centurygames.feishu.cn/docx/doxNOACCESS1', '--output', path.join(tempDir('fs-out-'), 'y.md')], ctx);
    assert.deepEqual([forbidden.code, forbidden.result!.status], [2, 'blocked']);
    assert.match(forbidden.result!.reason, /没有这份文档的阅读权限（错误码 1770032）/);
  } finally { await mock.stop(); }
});
