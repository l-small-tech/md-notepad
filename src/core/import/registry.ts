/**
 * Import-converter registry: turns foreign document formats into markdown.
 * Conversion is explicitly best-effort/lossy. Converters are pure with
 * respect to the filesystem — bytes in (base64), markdown + extracted
 * images out; the session controller owns all disk IO and image placement.
 *
 * Adding a format = one converter module + one entry in CONVERTERS.
 */

export interface ImportedImage {
  /** Raw image bytes, base64-encoded. */
  base64: string;
  /** Extension including the dot (`.png`). */
  ext: string;
  /** Suggested basename (no extension), or null for a generated default. */
  name: string | null;
}

export interface ImportResult {
  /**
   * Generated markdown. Extracted images appear as placeholder lines
   * (`imagePlaceholder(i)`), index-matched to `images`, replaced by the
   * caller once the images have real on-disk destinations.
   */
  markdown: string;
  images: ImportedImage[];
}

export interface Converter {
  /** Extensions (incl. dot, lowercase) this converter handles. */
  extensions: string[];
  /** Human label for dialogs/notices, e.g. 'PDF document'. */
  label: string;
  /**
   * False for a format that is recognized (listed in the explorer, offered for
   * import) but whose converter is not implemented yet — the session refuses
   * with a "<label> import isn't available yet." notice instead of running
   * `convert`. Defaults to true (a working converter).
   */
  available?: boolean;
  convert(bytesBase64: string, name: string): Promise<ImportResult>;
}

const CONVERTERS: Converter[] = [
  {
    extensions: ['.pdf'],
    label: 'PDF document',
    convert: async (bytesBase64, name) => (await import('./pdf')).convertPdf(bytesBase64, name),
  },
  {
    extensions: ['.docx'],
    label: 'Word document',
    convert: async (bytesBase64, name) => (await import('./docx')).convertDocx(bytesBase64, name),
  },
];

/** The converter registered for `ext` (incl. dot, any case), or null. */
export function converterFor(ext: string): Converter | null {
  const key = ext.toLowerCase();
  return CONVERTERS.find((c) => c.extensions.includes(key)) ?? null;
}

/** True when `name`/path ends in an extension some converter recognizes. */
export function isImportablePath(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && converterFor(name.slice(dot)) !== null;
}

/** Dialog filter covering every importable extension (no dots). */
export const importFilters: { name: string; extensions: string[] }[] = [
  {
    name: 'Importable documents',
    extensions: CONVERTERS.flatMap((c) => c.extensions.map((e) => e.slice(1))),
  },
];

/** The placeholder line a converter emits for extracted image `i`. */
export function imagePlaceholder(i: number): string {
  return `<!--import-img-${i}-->`;
}

/**
 * Replace each `<!--import-img-N-->` with `links[N]`. A null link (the image
 * could not be saved) drops the whole placeholder line instead.
 */
export function replaceImagePlaceholders(md: string, links: (string | null)[]): string {
  return md
    .split('\n')
    .map((line) => {
      const m = /^<!--import-img-(\d+)-->$/.exec(line.trim());
      if (!m) {
        return line.replace(/<!--import-img-(\d+)-->/g, (_, n) => links[Number(n)] ?? '');
      }
      return links[Number(m[1])] ?? null;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}
