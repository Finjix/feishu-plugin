/*
 * A Feishu document as Markdown: a docx from its blocks (headings, paragraphs, lists, to-dos, code, quotes, callouts, tables, dividers;
 * pictures, files and embedded objects as a placeholder in brackets), a sheet tab as a table. What it is for is reading: the text and its
 * structure come through, the looks do not (colors, alignment, column widths).
 */

type Obj = Record<string, any>;

const HEADINGS: Record<number, number> = { 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 6, 10: 6, 11: 6 };
const BODY: Record<number, string> = {
  2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5', 8: 'heading6', 9: 'heading7', 10: 'heading8',
  11: 'heading9', 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo',
};
const PLACEHOLDER: Record<number, string> = {
  18: '[多维表格]', 20: '[群名片]', 21: '[流程图]', 26: '[内嵌网页]', 28: '[应用]', 29: '[思维笔记]', 30: '[内嵌电子表格]', 33: '[视图]',
  35: '[任务]', 36: '[OKR]', 40: '[小组件]', 43: '[画板]',
};

const decode = (url: string): string => { try { return decodeURIComponent(url); } catch { return url; } };

/** Text runs with their inline marks; mentions by name or title, equations as they are written. */
export function inline(elements: unknown): string {
  if (!Array.isArray(elements)) return '';
  return (elements as Obj[]).map(e => {
    if (e.text_run) {
      const run = e.text_run;
      let text = String(run.content ?? '');
      const style = run.text_element_style ?? {};
      if (!text.trim()) return text;
      if (style.inline_code) text = `\`${text}\``;
      else {
        if (style.bold) text = `**${text}**`;
        if (style.italic) text = `*${text}*`;
        if (style.strikethrough) text = `~~${text}~~`;
      }
      if (style.link?.url) text = `[${text}](${decode(String(style.link.url))})`;
      return text;
    }
    if (e.mention_doc) return e.mention_doc.url ? `[${e.mention_doc.title ?? '文档'}](${decode(String(e.mention_doc.url))})` : String(e.mention_doc.title ?? '');
    if (e.mention_user) return '@用户';
    if (e.equation) return `$${String(e.equation.content ?? '').trim()}$`;
    if (e.file) return '[附件]';
    if (e.reminder) return '[提醒]';
    return '';
  }).join('');
}

/** A cell's text for a Markdown table: no line breaks, no column separators. */
const cellText = (text: string): string => text.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim();

export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const width = Math.max(1, ...rows.map(r => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cellText(cells[i] ?? '')).join(' | ')} |`;
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

export function docxToMarkdown(blocks: Obj[]): string {
  const byId = new Map(blocks.map(b => [String(b.block_id), b]));
  const page = blocks.find(b => b.block_type === 1);
  if (!page) return '';
  const children = (block: Obj): Obj[] => ((block.children ?? []) as string[]).map(id => byId.get(String(id))).filter((b): b is Obj => !!b);

  /** A block and what is below it, as Markdown lines; `indent` is the list depth. */
  const render = (block: Obj, indent: string): string[] => {
    const type = Number(block.block_type);
    const body = block[BODY[type] ?? ''] ?? {};
    const text = inline(body.elements);
    const nested = (prefix: string) => children(block).flatMap(child => render(child, prefix));
    if (HEADINGS[type]) return [`${'#'.repeat(HEADINGS[type])} ${text}`.trimEnd(), '', ...nested(indent)];
    switch (type) {
      case 2: return [...(text.trim() ? [`${indent}${text}`, ...(indent ? [] : [''])] : []), ...nested(indent)];
      case 12: return [`${indent}- ${text}`, ...nested(`${indent}  `)];
      case 13: return [`${indent}1. ${text}`, ...nested(`${indent}   `)];
      case 17: return [`${indent}- [${body.style?.done ? 'x' : ' '}] ${text}`, ...nested(`${indent}  `)];
      case 14: return ['```', ...((body.elements ?? []) as Obj[]).map(e => String(e.text_run?.content ?? '')).join('').split('\n'), '```', ''];
      case 15: return [`> ${text}`, ''];
      case 19: case 34: {
        const inner = nested('').filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''));
        return [...inner.map(line => (line ? `> ${line}` : '>')), ''];
      }
      case 22: return ['---', ''];
      case 27: return [`${indent}[图片]`, ''];
      case 23: return [`${indent}[文件：${block.file?.name ?? ''}]`, ''];
      case 24: case 25: return nested(indent);
      case 31: {
        const property = block.table?.property ?? {};
        const rows = Number(property.row_size), cols = Number(property.column_size);
        const cells: string[] = block.table?.cells ?? block.children ?? [];
        if (!Number.isInteger(rows) || !Number.isInteger(cols) || cells.length !== rows * cols) return ['[表格]', ''];
        const covered = new Set<number>();
        ((property.merge_info ?? []) as Obj[]).forEach((span, i) => {
          const [r, c] = [Math.floor(i / cols), i % cols];
          for (let dr = 0; dr < (span.row_span ?? 1); dr++) for (let dc = 0; dc < (span.col_span ?? 1); dc++) if (dr || dc) covered.add((r + dr) * cols + c + dc);
        });
        const shown = (id: string, at: number) => {
          const cell = byId.get(String(id));
          if (covered.has(at) || !cell) return '';
          return children(cell).flatMap(child => render(child, '')).filter(line => line !== '').join('\n');
        };
        const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => shown(cells[r * cols + c]!, r * cols + c)));
        return [table(grid), ''];
      }
      default:
        if (PLACEHOLDER[type]) return [`${indent}${PLACEHOLDER[type]}`, ''];
        return [...(text.trim() ? [`${indent}${text}`, ''] : []), ...nested(indent)];
    }
  };

  // List items are written line after line; a blank line closes a run of them.
  const isList = (block: Obj | undefined) => [12, 13, 17].includes(Number(block?.block_type));
  const top = children(page);
  const out = top.flatMap((block, i) => [...render(block, ''), ...(isList(block) && !isList(top[i + 1]) ? [''] : [])]);
  const title = inline(page.page?.elements).trim();
  return `${title ? `# ${title}\n\n` : ''}${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
