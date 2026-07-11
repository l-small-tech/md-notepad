import { describe, expect, test } from 'vitest';
import { imageTargetDir } from '../image-insert';

const join = (dir: string, name: string) => `${dir}/${name}`;

describe('imageTargetDir', () => {
  const base = {
    mdDir: '/ws/sub',
    workspaceRoot: '/ws',
    folderName: 'images',
    join,
  };

  test("'sameFolder' saves right beside the markdown file", () => {
    expect(imageTargetDir({ ...base, location: 'sameFolder' })).toBe('/ws/sub');
  });

  test("'subfolder' saves into a named folder beside the file", () => {
    expect(imageTargetDir({ ...base, location: 'subfolder' })).toBe('/ws/sub/images');
  });

  test("'workspaceRoot' saves into a named folder at the workspace root", () => {
    expect(imageTargetDir({ ...base, location: 'workspaceRoot' })).toBe('/ws/images');
  });

  test('a blank folder name collapses subfolder/root modes to no subfolder', () => {
    expect(imageTargetDir({ ...base, folderName: '', location: 'subfolder' })).toBe('/ws/sub');
    expect(imageTargetDir({ ...base, folderName: '', location: 'workspaceRoot' })).toBe('/ws');
  });

  test('a custom folder name is honored', () => {
    expect(imageTargetDir({ ...base, folderName: 'assets', location: 'subfolder' })).toBe(
      '/ws/sub/assets',
    );
  });
});
