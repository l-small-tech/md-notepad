/**
 * ImageView — the read-only viewer behind an image tab. Fills the editor
 * stack like an EditorHost does, but renders a single centered image on the
 * read-mode surface instead of mounting any editor.
 *
 * The image arrives as a data: URL through the session controller
 * (loadImageDataUrl → read_file_base64) so no asset-protocol scope is needed.
 * It reloads when the tab's filePath changes (rename-on-disk retargets it).
 */

import { memo, useEffect, useState } from 'react';
import { loadImageDataUrl } from '../session';
import { useTabsStore } from '../stores/tabs';

function ImageViewImpl({ tabId, active }: { tabId: string; active: boolean }) {
  const filePath = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  // Keyed by the path it was loaded for, so a rename shows "Loading…" (a
  // stale-path entry) instead of the previous image; url null = load failed.
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!filePath) {
      return;
    }
    let cancelled = false;
    void loadImageDataUrl(filePath)
      .then((url) => {
        if (!cancelled) {
          setLoaded({ path: filePath, url });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ path: filePath, url: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const src = loaded !== null && loaded.path === filePath ? loaded.url : undefined;

  return (
    <div className="editor-host image-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="image-view" tabIndex={0}>
        {src === undefined ? (
          <div className="image-view-status">Loading…</div>
        ) : src === null ? (
          <div className="image-view-status">Could not load this image.</div>
        ) : (
          <img className="image-view-img" src={src} alt={filePath ?? 'image'} draggable={false} />
        )}
      </div>
    </div>
  );
}

export const ImageView = memo(ImageViewImpl);
