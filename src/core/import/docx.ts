/**
 * DOCX → markdown converter (best effort, explicitly lossy). mammoth turns
 * Word's XML into semantic HTML; embedded images are pulled out to the
 * ImportedImage[] channel as index tokens, then docx-html.ts reduces the HTML
 * to markdown and the tokens become the registry's image placeholders.
 *
 * mammoth is dynamically imported so its weight (plus JSZip) stays out of the
 * startup bundle — the registry imports this module lazily, like pdf.ts. The
 * browser field in mammoth's package.json swaps in the JSZip-based unzip, so
 * the same import works in the webview. Touches no ipc: the session controller
 * owns disk IO and image placement.
 */

import { base64ToBytes, extForImageMime } from '../images';
import { htmlToMarkdown } from './docx-html';
import { imagePlaceholder, type ImportResult, type ImportedImage } from './registry';

type Mammoth = typeof import('mammoth');

let mammothPromise: Promise<Mammoth> | null = null;

function loadMammoth(): Promise<Mammoth> {
  mammothPromise ??= import('mammoth').then(
    (m) => (m as unknown as { default: Mammoth }).default ?? m,
  );
  return mammothPromise;
}

/** The `<img src>` mammoth emits for extracted image `i`; swapped out later. */
export function imageTokenSrc(i: number): string {
  return `import-img-${i}`;
}

/**
 * Turn the markdown image links pointing at our tokens back into the
 * registry's placeholder comments, so the session can drop in real on-disk
 * links (or remove the line when an image could not be saved).
 */
export function swapImageTokens(md: string): string {
  return md.replace(/!\[[^\]]*\]\(import-img-(\d+)\)/g, (_, n: string) =>
    imagePlaceholder(Number(n)),
  );
}

/**
 * File extension (incl. dot) for a DOCX image's content type. Known raster
 * types map through the shared image vocabulary; anything else (e.g. Word's
 * EMF/WMF metafiles) keeps its subtype so the bytes are still saved, even if
 * markdown can't render them.
 */
export function extForDocxImage(contentType: string): string {
  const known = extForImageMime(contentType.toLowerCase());
  if (known) {
    return known;
  }
  const subtype = contentType.toLowerCase().split('/')[1]?.replace(/^x-/, '') ?? 'bin';
  return `.${subtype || 'bin'}`;
}

/** Convert one DOCX (base64 bytes) to markdown + extracted images. */
export async function convertDocx(bytesBase64: string, name: string): Promise<ImportResult> {
  const mammoth = await loadMammoth();
  const bytes = base64ToBytes(bytesBase64);
  const baseName = name.replace(/\.[^.]*$/, '').toLowerCase() || 'import';
  const images: ImportedImage[] = [];

  // mammoth calls this per embedded image. The index/read pair is atomic (no
  // await between reserving the index and the push), so tokens stay matched to
  // their images even though reads resolve out of order.
  const convertImage = mammoth.images.imgElement(async (image) => {
    const base64 = await image.readAsBase64String();
    const index = images.length;
    images.push({
      base64,
      ext: extForDocxImage(image.contentType),
      name: `${baseName}-img-${index + 1}`,
    });
    return { src: imageTokenSrc(index) };
  });

  // mammoth's browser unzip reads `arrayBuffer`; its Node unzip reads `buffer`.
  // Supplying both lets the same call work in the webview and under Vitest —
  // each build reads its key and ignores the other.
  const source = bytes.buffer as ArrayBuffer;
  const input = { arrayBuffer: source, buffer: source } as Parameters<Mammoth['convertToHtml']>[0];
  const { value: html } = await mammoth.convertToHtml(input, { convertImage });
  const markdown = swapImageTokens(await htmlToMarkdown(html));
  return { markdown: markdown ? `${markdown}\n` : '', images };
}
