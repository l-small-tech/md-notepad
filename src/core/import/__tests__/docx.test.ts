import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';

import { convertDocx, extForDocxImage, imageTokenSrc, swapImageTokens } from '../docx';

describe('imageTokenSrc / swapImageTokens', () => {
  test('a token src round-trips into the registry placeholder', () => {
    const md = `intro\n\n![](${imageTokenSrc(0)})\n\nmore ![alt](${imageTokenSrc(2)}) inline`;
    expect(swapImageTokens(md)).toBe(
      'intro\n\n<!--import-img-0-->\n\nmore <!--import-img-2--> inline',
    );
  });

  test('leaves non-token image links untouched', () => {
    const md = '![photo](pics/cat.png)';
    expect(swapImageTokens(md)).toBe(md);
  });
});

describe('extForDocxImage', () => {
  test('maps known raster content types through the shared vocabulary', () => {
    expect(extForDocxImage('image/png')).toBe('.png');
    expect(extForDocxImage('image/jpeg')).toBe('.jpg');
    expect(extForDocxImage('image/gif')).toBe('.gif');
    expect(extForDocxImage('IMAGE/PNG')).toBe('.png');
  });

  test('falls back to the subtype for Word metafiles and unknowns', () => {
    expect(extForDocxImage('image/x-emf')).toBe('.emf');
    expect(extForDocxImage('image/x-wmf')).toBe('.wmf');
    expect(extForDocxImage('application/octet-stream')).toBe('.octet-stream');
  });
});

// A 1×1 transparent PNG — the smallest embeddable image.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    <w:p>
      <w:r><w:t xml:space="preserve">Hello </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>world</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:drawing><wp:inline>
        <wp:extent cx="100" cy="100"/>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill>
          </pic:pic>
        </a:graphicData></a:graphic>
      </wp:inline></w:drawing></w:r>
    </w:p>
  </w:body>
</w:document>`;

/** Assemble a minimal but valid .docx and return it base64-encoded. */
async function buildDocxBase64(): Promise<string> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', DOCUMENT);
  zip.file('word/_rels/document.xml.rels', DOC_RELS);
  zip.file('word/media/image1.png', PNG_BASE64, { base64: true });
  return zip.generateAsync({ type: 'base64' });
}

describe('convertDocx (end to end)', () => {
  test('converts text and extracts an embedded image to a placeholder', async () => {
    const bytes = await buildDocxBase64();

    const result = await convertDocx(bytes, 'Memo.docx');

    expect(result.markdown).toContain('Hello **world**');
    expect(result.markdown).toContain('<!--import-img-0-->');
    expect(result.markdown.endsWith('\n')).toBe(true);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.ext).toBe('.png');
    expect(result.images[0]!.base64).toBe(PNG_BASE64);
    expect(result.images[0]!.name).toBe('memo-img-1');
  });
});
