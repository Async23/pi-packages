import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

marked.setOptions({ gfm: true, breaks: true });

// 外部链接新窗口打开
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text) {
  if (!text) return '';
  const html = marked.parse(text);
  const clean = DOMPurify.sanitize(html);
  return clean;
}

/** 对容器内 pre>code 做语法高亮（渲染后调用） */
export function highlightIn(el) {
  if (!el) return;
  el.querySelectorAll('pre code:not(.hljs)').forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch {
      // ignore
    }
  });
}
