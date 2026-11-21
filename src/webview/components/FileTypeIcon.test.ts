import { describe, expect, it } from 'vitest';
import dockerIcon from 'material-icon-theme/icons/docker.svg?raw';
import goIcon from 'material-icon-theme/icons/go.svg?raw';
import goModIcon from 'material-icon-theme/icons/go-mod.svg?raw';
import gradleIcon from 'material-icon-theme/icons/gradle.svg?raw';
import nodeIcon from 'material-icon-theme/icons/nodejs.svg?raw';
import readmeIcon from 'material-icon-theme/icons/readme.svg?raw';
import { createFileTypeIconElement, getFileTypeIcon, hasRecognizedFileType } from './FileTypeIcon';

function artwork(svg: string): string {
  return svg.replace(/\bviewBox="[^"]+"/, '');
}

function fileArtwork(path: string): string {
  return artwork(decodeURIComponent(getFileTypeIcon(path).slice('data:image/svg+xml,'.length)));
}

describe('getFileTypeIcon', () => {
  it('distinguishes common source formats', () => {
    expect(getFileTypeIcon('src/App.tsx')).not.toBe(getFileTypeIcon('src/app.ts'));
    expect(getFileTypeIcon('src/app.ts')).not.toBe(getFileTypeIcon('src/app.css'));
  });

  it('distinguishes media formats from generic files', () => {
    expect(getFileTypeIcon('recording.mp4')).not.toBe(getFileTypeIcon(undefined));
    expect(getFileTypeIcon('recording.mp3')).not.toBe(getFileTypeIcon('recording.mp4'));
  });

  it('uses filename-specific icons and a generic fallback', () => {
    expect(getFileTypeIcon('/workspace/Dockerfile')).toBe(
      getFileTypeIcon('/workspace/.dockerignore')
    );
    expect(getFileTypeIcon('unknown.custom-extension')).toBe(getFileTypeIcon(undefined));
  });

  it('uses the pink Go module icon for module files and keeps the source icon for .go files', () => {
    for (const path of ['go.mod', 'go.sum', '/workspace/go.mod', 'C:\\workspace\\GO.SUM']) {
      expect(fileArtwork(path)).toBe(artwork(goModIcon));
      expect(hasRecognizedFileType(path)).toBe(true);
    }
    expect(fileArtwork('main.go')).toBe(artwork(goIcon));
    expect(goModIcon).not.toBe(goIcon);
  });

  it('uses the Git icon for remote names ending in .git', () => {
    expect(getFileTypeIcon('browser-bridge.git')).toBe(getFileTypeIcon('.gitignore'));
  });

  it('recognizes Gradle scripts, wrappers, and configuration instead of their generic extensions', () => {
    for (const path of [
      'build.gradle',
      'settings.gradle.kts',
      'build.gradle.kts',
      'gradle.properties',
      'gradle/wrapper/gradle-wrapper.properties',
      'gradlew',
      'gradlew.bat',
    ]) {
      expect(fileArtwork(`/workspace/${path}`)).toBe(artwork(gradleIcon));
      expect(hasRecognizedFileType(path)).toBe(true);
    }
    expect(getFileTypeIcon('other.properties')).not.toBe(gradleIcon);
    expect(getFileTypeIcon('script.kts')).not.toBe(gradleIcon);
  });

  it('uses filename-specific icons for common manifests and project files', () => {
    expect(fileArtwork('package.json')).toBe(artwork(nodeIcon));
    expect(fileArtwork('README.md')).toBe(artwork(readmeIcon));
    expect(fileArtwork('docker-compose.yml')).toBe(artwork(dockerIcon));
    expect(fileArtwork('compose.yaml')).toBe(artwork(dockerIcon));
    expect(getFileTypeIcon('notes.md')).not.toBe(readmeIcon);
    expect(getFileTypeIcon('other.yml')).not.toBe(dockerIcon);
  });
});

describe('createFileTypeIconElement', () => {
  it.each(['main.go', 'go.mod', 'README.md', 'index.php', 'app.ts', 'app.c', 'unknown.file'])(
    'normalizes artwork rather than the square canvas for %s',
    (path) => {
      const icon = createFileTypeIconElement(path);
      expect(icon.src).toContain(getFileTypeIcon(path));
      const fill = Number(icon.style.getPropertyValue('--file-icon-fill'));
      const aspect = Number(icon.style.getPropertyValue('--file-icon-aspect'));
      expect(fill).toBeGreaterThan(0);
      expect(fill).toBeLessThanOrEqual(0.875);
      expect(fill * aspect).toBeLessThanOrEqual(1.25);
      expect(aspect).toBeGreaterThan(0);
      const svg = decodeURIComponent(icon.src.slice('data:image/svg+xml,'.length));
      const viewBox = svg
        .match(/\bviewBox="([^"]+)"/)?.[1]
        ?.split(/\s+/)
        .map(Number);
      expect(viewBox).toHaveLength(4);
      expect(viewBox?.[2]).toBeGreaterThan(0);
      expect(viewBox?.[3]).toBeGreaterThan(0);
      expect(icon.classList.contains('low-ink-icon')).toBe(false);
      expect(icon.alt).toBe('');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.draggable).toBe(false);
    }
  );

  it('balances wide and tall artwork without stretching either or forcing equal heights', () => {
    const aspect = (path: string) =>
      Number(createFileTypeIconElement(path).style.getPropertyValue('--file-icon-aspect'));
    expect(aspect('main.go')).toBeCloseTo(32 / 13);
    expect(aspect('notes.md')).toBeGreaterThan(1.8);
    expect(aspect('index.php')).toBeGreaterThan(1.9);
    expect(aspect('app.ts')).toBe(1);
    expect(aspect('app.c')).toBeLessThan(0.7);
    const fill = (path: string) =>
      Number(createFileTypeIconElement(path).style.getPropertyValue('--file-icon-fill'));
    expect(fill('main.go')).toBeLessThan(fill('app.ts'));
    expect(fill('app.c')).toBeGreaterThan(fill('app.ts'));
  });
});
