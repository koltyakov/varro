import { describe, expect, it } from 'vitest';
import dockerIcon from 'material-icon-theme/icons/docker.svg';
import gradleIcon from 'material-icon-theme/icons/gradle.svg';
import nodeIcon from 'material-icon-theme/icons/nodejs.svg';
import readmeIcon from 'material-icon-theme/icons/readme.svg';
import { getFileTypeIcon, hasRecognizedFileType } from './FileTypeIcon';

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

  it('uses Go icons for Go module files', () => {
    expect(getFileTypeIcon('go.mod')).toBe(getFileTypeIcon('main.go'));
    expect(getFileTypeIcon('go.sum')).toBe(getFileTypeIcon('main.go'));
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
      expect(getFileTypeIcon(`/workspace/${path}`)).toBe(gradleIcon);
      expect(hasRecognizedFileType(path)).toBe(true);
    }
    expect(getFileTypeIcon('other.properties')).not.toBe(gradleIcon);
    expect(getFileTypeIcon('script.kts')).not.toBe(gradleIcon);
  });

  it('uses filename-specific icons for common manifests and project files', () => {
    expect(getFileTypeIcon('package.json')).toBe(nodeIcon);
    expect(getFileTypeIcon('README.md')).toBe(readmeIcon);
    expect(getFileTypeIcon('docker-compose.yml')).toBe(dockerIcon);
    expect(getFileTypeIcon('compose.yaml')).toBe(dockerIcon);
    expect(getFileTypeIcon('notes.md')).not.toBe(readmeIcon);
    expect(getFileTypeIcon('other.yml')).not.toBe(dockerIcon);
  });
});
