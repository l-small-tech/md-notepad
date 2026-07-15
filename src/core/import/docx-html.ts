/**
 * Pure HTML → markdown reduction for the DOCX importer. mammoth turns a Word
 * document into semantic HTML (headings, lists, tables, emphasis, links,
 * images); this collapses that HTML to GitHub-flavored markdown with the
 * unified rehype→remark pipeline. Kept free of mammoth and the DOM so it is
 * cheap to unit-test in isolation, mirroring pdf-text.ts.
 */

import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    listItemIndent: 'one',
    rule: '-',
  })
  .freeze();

/**
 * Convert an HTML fragment to markdown. GFM constructs (tables, strikethrough)
 * survive; unknown/unsupported HTML is dropped rather than passed through.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const file = await processor.process(html);
  return String(file).trim();
}
