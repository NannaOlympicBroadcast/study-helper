// Markdown + LaTeX rendering (marked + KaTeX). Supports $...$, $$...$$, \(...\), \[...\].
import { Marked } from 'marked';
import katex from 'katex';

function tex(src, displayMode) {
  try {
    return katex.renderToString(src, { displayMode, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml' });
  } catch (e) {
    return `<code class="tex-error">${src}</code>`;
  }
}

const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const m = src.match(/\$\$|\\\[/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src) || /^\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/.exec(src);
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer(token) {
    return `<div class="math-block">${tex(token.text, true)}</div>\n`;
  },
};

const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const m = src.match(/\$|\\\(/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    let m = /^\$\$([\s\S]+?)\$\$/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true };
    m = /^\$((?:\\\$|[^$\n])+?)\$(?!\d)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: false };
    m = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: false };
    return undefined;
  },
  renderer(token) {
    return tex(token.text, token.display);
  },
};

const marked = new Marked({ gfm: true, breaks: true });
marked.use({ extensions: [blockMath, inlineMath] });

export function renderMarkdown(src) {
  return marked.parse(String(src || ''));
}
