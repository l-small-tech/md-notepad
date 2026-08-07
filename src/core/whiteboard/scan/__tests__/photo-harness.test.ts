/**
 * OFFLINE HARNESS, not a regression test — runs the full scan pipeline
 * (detect → rectify → clean → trace) against a real photo dumped to raw BGRA,
 * and writes stats + render inputs for visual inspection. Skipped unless
 * SCAN_HARNESS_DIR points at a directory containing photo.bgra + photo.json
 * ({ width, height, stride }). Kept in-tree because quality tuning against
 * real boards is a recurring need (phases 5 and 6 both did it by hand).
 *
 *   SCAN_HARNESS_DIR=...photo SCAN_PRESET=balanced pnpm vitest run photo-harness
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectBoardQuad } from '../quad';
import { createRectifier } from '../pipeline';
import { createCleaner, composeCleaned, composeRemovedDebug } from '../clean';
import { normalizeIllumination, detectGlare } from '../illumination';
import { binarize } from '../binarize';
import { createTracer, fitScanElements, type TracedStroke } from '../trace';
import { elementInk, groupTextLines, layoutItemsFromTrace } from '../text-layout';
import type { RgbaImage, ScanPreset } from '../types';

const dir = process.env['SCAN_HARNESS_DIR'];

describe.runIf(dir)('scan photo harness', () => {
  it('runs the pipeline and dumps stats', () => {
    const meta = JSON.parse(readFileSync(join(dir!, 'photo.json'), 'utf8')) as {
      width: number;
      height: number;
      stride: number;
    };
    const bgra = readFileSync(join(dir!, 'photo.bgra'));
    const data = new Uint8ClampedArray(meta.width * meta.height * 4);
    for (let y = 0; y < meta.height; y++) {
      for (let x = 0; x < meta.width; x++) {
        const s = y * meta.stride + x * 4;
        const d = (y * meta.width + x) * 4;
        data[d] = bgra[s + 2]!;
        data[d + 1] = bgra[s + 1]!;
        data[d + 2] = bgra[s]!;
        data[d + 3] = 255;
      }
    }
    const image: RgbaImage = { width: meta.width, height: meta.height, data };

    const t0 = performance.now();
    const detection = detectBoardQuad(image);
    const preset = (process.env['SCAN_PRESET'] ?? 'balanced') as ScanPreset;
    const rectifier = createRectifier(image, detection.quad, preset)!;
    while (!rectifier.done) {
      rectifier.step(512);
    }
    const rectified = rectifier.result()!;
    const t1 = performance.now();

    const cleaner = createCleaner(rectified);
    while (!cleaner.done) {
      cleaner.step();
    }
    const clean = cleaner.result()!;
    const t2 = performance.now();

    const tracer = createTracer(clean);
    while (!tracer.done) {
      tracer.step();
    }
    const trace = tracer.result()!;
    const t3 = performance.now();

    const w = trace.strokeWidth;
    const lines: string[] = [];
    const out = (s: string): void => {
      lines.push(s);
    };
    out(`photo ${meta.width}x${meta.height}  quad=${detection.source}  preset=${preset}`);
    out(`rectified ${rectified.width}x${rectified.height}`);
    out(
      `timings ms: rectify=${(t1 - t0).toFixed(0)} clean=${(t2 - t1).toFixed(0)} trace=${(t3 - t2).toFixed(0)}`,
    );
    out(`page strokeWidth w=${w.toFixed(2)} px`);
    out(`components: ${trace.components.length}`);

    // Every removed component with the filter that killed it and the stats the
    // filter judged — the first place to look when ink is missing.
    {
      const removed = clean.extraction.removedComponents;
      const cw = clean.extraction.strokeWidth;
      out(`removed components: ${removed.length}`);
      const bySize = [...removed].sort((a, b) => b.component.area - a.component.area).slice(0, 30);
      for (const { component: c, reason } of bySize) {
        out(
          `  ${reason} bbox=${c.minX},${c.minY}..${c.maxX},${c.maxY} area/w2=${(c.area / (cw * cw)).toFixed(1)} ` +
            `thinness=${c.thinness.toFixed(1)} strongRatio=${c.strongRatio.toFixed(2)} ` +
            `dtMax/w=${(c.dtMax / cw).toFixed(2)} glareRatio=${c.glareRatio.toFixed(2)} ` +
            `border=${c.touchesBorder}`,
        );
      }
      const removedVis = composeRemovedDebug(clean);
      writeFileSync(join(dir!, 'removed.rgba'), Buffer.from(removedVis.data.buffer));
      writeFileSync(
        join(dir!, 'removed.json'),
        JSON.stringify({ width: removedVis.width, height: removedVis.height }),
      );
    }

    const strokes = trace.components.filter((c): c is TracedStroke => c.kind === 'stroke');
    const fills = trace.components.filter((c) => c.kind === 'fill');
    const pathLength = (p: readonly { x: number; y: number }[]): number => {
      let total = 0;
      for (let i = 1; i < p.length; i++) {
        total += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y);
      }
      return total;
    };

    const dots = strokes.filter((s) => s.paths.length === 1 && s.paths[0]!.length === 1);
    out(`stroke components: ${strokes.length} (dots: ${dots.length}), fills: ${fills.length}`);
    const dotWidths = dots.map((d) => d.widths[0]![0]!).sort((a, b) => a - b);
    out(`dot widths (px, w=${w.toFixed(1)}): ${dotWidths.map((v) => v.toFixed(1)).join(' ')}`);

    // Path population across all stroke components, by length in units of w.
    const allPaths: { component: number; length: number; points: number; width: number }[] = [];
    strokes.forEach((s, si) => {
      s.paths.forEach((p, pi) => {
        allPaths.push({
          component: si,
          length: pathLength(p),
          points: p.length,
          width: s.widths[pi]!.length > 0 ? s.strokeWidth : 0,
        });
      });
    });
    const buckets = new Map<string, number>();
    for (const p of allPaths) {
      const r = p.length / w;
      const key =
        r < 0.5
          ? '<0.5w'
          : r < 1
            ? '0.5-1w'
            : r < 2
              ? '1-2w'
              : r < 4
                ? '2-4w'
                : r < 8
                  ? '4-8w'
                  : r < 16
                    ? '8-16w'
                    : '>=16w';
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    out(`paths total: ${allPaths.length}; length histogram (units of w):`);
    for (const key of ['<0.5w', '0.5-1w', '1-2w', '2-4w', '4-8w', '8-16w', '>=16w']) {
      out(`  ${key}: ${buckets.get(key) ?? 0}`);
    }

    // Fragmentation suspects: components with the most paths.
    const byPaths = strokes
      .map((s, si) => ({ si, s }))
      .sort((a, b) => b.s.paths.length - a.s.paths.length)
      .slice(0, 12);
    out(`top components by path count:`);
    for (const { si, s } of byPaths) {
      const box = s.paths.flat().reduce(
        (a, p) => ({
          minX: Math.min(a.minX, p.x),
          minY: Math.min(a.minY, p.y),
          maxX: Math.max(a.maxX, p.x),
          maxY: Math.max(a.maxY, p.y),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      );
      const lengths = s.paths.map((p) => (pathLength(p) / w).toFixed(1)).join(',');
      out(
        `  #${si} paths=${s.paths.length} sw=${s.strokeWidth.toFixed(1)} bbox=${Math.round(box.minX)},${Math.round(box.minY)}..${Math.round(box.maxX)},${Math.round(box.maxY)} lengths/w=[${lengths}]`,
      );
    }

    // Per-path width spread inside multi-path components (the "inconsistently
    // thick" symptom): min/max of per-path median widths.
    out(`per-path median widths for top fragmenters:`);
    for (const { si, s } of byPaths.slice(0, 6)) {
      const medians = s.widths.map((ws) => {
        const sorted = [...ws].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      });
      out(
        `  #${si}: [${medians.map((m) => m.toFixed(1)).join(', ')}] stroke=${s.strokeWidth.toFixed(1)}`,
      );
    }

    // Binarize masks over the normalized image: kept label = black,
    // weak-but-unkept = orange, strong = dark — shows what the gates saw.
    {
      const norm = normalizeIllumination(rectified).normalized;
      const glare = detectGlare(rectified);
      const masks = binarize(norm, glare.mask);
      const vis = new Uint8ClampedArray(rectified.width * rectified.height * 4);
      for (let i = 0; i < rectified.width * rectified.height; i++) {
        const p = i * 4;
        let r = 255;
        let g = 255;
        let b = 255;
        if (clean.extraction.labels[i] !== 0) {
          r = 40;
          g = 40;
          b = 40; // kept ink
        } else if (masks.strong[i] !== 0) {
          r = 200;
          g = 40;
          b = 40; // strong but not kept
        } else if (masks.weak[i] !== 0) {
          r = 255;
          g = 165;
          b = 0; // weak only, not kept
        }
        vis[p] = r;
        vis[p + 1] = g;
        vis[p + 2] = b;
        vis[p + 3] = 255;
      }
      writeFileSync(join(dir!, 'masks.rgba'), Buffer.from(vis.buffer));
      writeFileSync(
        join(dir!, 'masks.json'),
        JSON.stringify({ width: rectified.width, height: rectified.height }),
      );
    }

    // Cleaned raster (true colours) for a PNG dump.
    const cleaned = composeCleaned(clean, 'true');
    writeFileSync(join(dir!, 'cleaned.rgba'), Buffer.from(cleaned.data.buffer));
    writeFileSync(
      join(dir!, 'cleaned.json'),
      JSON.stringify({ width: cleaned.width, height: cleaned.height }),
    );

    // Built elements at identity transform for the vector renderer.
    const fitted = fitScanElements(trace, clean.colors, { mode: 'true' });
    out(
      `fitted: strokes=${fitted.strokes} bytes=${fitted.bytes} epsilonFactor=${fitted.epsilonFactor} reduced=${fitted.reduced}`,
    );
    const render = fitted.elements.map((e) => ({
      tool: e.tool,
      stroke: e.stroke,
      strokeWidth: e.strokeWidth,
      d: e.d,
      widths: e.widths,
    }));
    writeFileSync(
      join(dir!, 'elements.json'),
      JSON.stringify({ width: rectified.width, height: rectified.height, elements: render }),
    );

    // Raw polylines + widths + colours for the System.Drawing renderer.
    const paths: unknown[] = [];
    for (const c of trace.components) {
      const color = clean.colors.byLabel.get(c.label);
      const hex = color ? color.measured : '#000000';
      if (c.kind === 'fill') {
        paths.push({
          kind: 'fill',
          color: hex,
          loops: c.loops.map((l) => l.map((p) => [p.x, p.y])),
        });
        continue;
      }
      c.paths.forEach((p, pi) => {
        const ws = [...c.widths[pi]!].sort((a, b) => a - b);
        paths.push({
          kind: p.length === 1 ? 'dot' : 'line',
          color: hex,
          width: ws[Math.floor(ws.length / 2)] ?? c.strokeWidth,
          points: p.map((q) => [q.x, q.y]),
        });
      });
    }
    writeFileSync(
      join(dir!, 'render.json'),
      JSON.stringify({ width: rectified.width, height: rectified.height, paths }),
    );

    // Phase 7: the text layout's verdict, plus the exact ink payload the
    // recognizers get — feed ocr-payload.json to an engine probe to judge
    // recognition quality offline.
    {
      const items = layoutItemsFromTrace(trace);
      const layout = groupTextLines(items, w);
      const ink = elementInk(trace);
      out(`text layout: ${layout.lines.length} lines, ${layout.diagram.length} diagram items`);
      const inLine = new Set(layout.lines.flatMap((l) => [...l.items]));
      for (const item of items) {
        const cls = inLine.has(item.index)
          ? 'line'
          : layout.diagram.includes(item.index)
            ? 'diagram'
            : 'dropped';
        out(
          `  item #${item.index} ${cls} bbox=${Math.round(item.bbox.x)},${Math.round(item.bbox.y)} ` +
            `${Math.round(item.bbox.width)}x${Math.round(item.bbox.height)}`,
        );
      }
      for (const line of layout.lines) {
        out(
          `  line bbox=${Math.round(line.bbox.x)},${Math.round(line.bbox.y)} ` +
            `${Math.round(line.bbox.width)}x${Math.round(line.bbox.height)} items=[${line.items.join(',')}]`,
        );
      }
      const payload = {
        lines: layout.lines.map((line) => ({
          strokes: line.items.flatMap((index) =>
            (ink[index] ?? []).map((path) => path.map((p) => [p.x, p.y])),
          ),
          area: {
            width: Math.max(1, Math.round(line.bbox.width)),
            height: Math.max(1, Math.round(line.bbox.height)),
          },
        })),
      };
      writeFileSync(join(dir!, 'ocr-payload.json'), JSON.stringify(payload));
    }

    const report = lines.join('\n');
    writeFileSync(join(dir!, 'stats.txt'), report);
    console.log(report);
  }, 600_000);
});
