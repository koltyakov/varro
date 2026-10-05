// @ts-check
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'assets/notifications');
const archivePath = join(assets, 'varro-notifier.zip');
const manifestPath = join(assets, 'varro-notifier.json');
const inputs = [
  'native/macos-notifications/main.m',
  'native/macos-notifications/Info.plist',
  'assets/icon.png',
  'scripts/build-macos-notifier.mjs',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function sourceHash() {
  const digest = createHash('sha256');
  for (const path of inputs) {
    digest.update(path);
    digest.update(await readFile(join(root, path)));
  }
  return digest.digest('hex');
}

/** All build platforms verify the checked-in first-party artifact against its source and digest. */
export async function verifyMacOSNotifierAsset(path = archivePath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.sourceHash !== (await sourceHash())) {
    throw new Error(
      'macOS notification helper source changed. Run npm run build:notifications:macos on macOS and commit the generated archive and manifest.'
    );
  }
  if (manifest.sha256 !== hash(await readFile(path)))
    throw new Error('macOS notification helper archive checksum mismatch');
}

/** A maintainer build; end users need neither a compiler nor runtime downloads. */
async function buildMacOSNotifier() {
  if (process.platform !== 'darwin')
    throw new Error(
      'Building the notification helper requires macOS with Apple Command Line Tools.'
    );
  const temporary = await mkdtemp(join(tmpdir(), 'varro-notifier-build-'));
  const run = (file, args) => execFileSync(file, args, { stdio: 'pipe' });
  try {
    const app = join(temporary, 'Varro.app');
    const contents = join(app, 'Contents');
    const executable = join(contents, 'MacOS/varro-notifier');
    await mkdir(dirname(executable), { recursive: true });
    await mkdir(join(contents, 'Resources'), { recursive: true });
    await copyFile(
      join(root, 'native/macos-notifications/Info.plist'),
      join(contents, 'Info.plist')
    );
    run('/usr/bin/xcrun', [
      '--sdk',
      'macosx',
      'clang',
      '-fobjc-arc',
      '-Os',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      '-mmacosx-version-min=11.0',
      '-framework',
      'Cocoa',
      '-framework',
      'CoreGraphics',
      '-framework',
      'UserNotifications',
      join(root, 'native/macos-notifications/main.m'),
      '-o',
      executable,
    ]);

    // Reuse the existing image dependency at build time to preserve the logo's aspect ratio and alpha.
    const { ImageMagick, initializeImageMagick, MagickColors, MagickFormat, Gravity } =
      await import('@imagemagick/magick-wasm');
    const require = createRequire(import.meta.url);
    await initializeImageMagick(
      await readFile(require.resolve('@imagemagick/magick-wasm/magick.wasm'))
    );
    const original = await readFile(join(root, 'assets/icon.png'));
    const iconset = join(temporary, 'Varro.iconset');
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const icon = ImageMagick.read(original, (image) => {
          image.resize(pixels, pixels);
          image.backgroundColor = MagickColors.Transparent;
          image.extent(pixels, pixels, Gravity.Center);
          return image.write(MagickFormat.Png, (bytes) => Buffer.from(bytes));
        });
        await writeFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), icon);
      }
    }
    run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(contents, 'Resources/Varro.icns')]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const version = JSON.parse(run(executable, ['--version']).toString('utf8'));
    if (version.name !== 'Varro' || version.bundleId !== 'com.koltyakov.varro.notifications')
      throw new Error('Notification helper identity smoke check failed');
    await mkdir(assets, { recursive: true });
    run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', app, archivePath]);
    const manifest = {
      sha256: hash(await readFile(archivePath)),
      sourceHash: await sourceHash(),
      bundleId: version.bundleId,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    // oxlint-disable-next-line no-console -- Maintainer command reports its generated first-party artifact.
    console.log(`Built Varro notification helper: ${archivePath}\nSHA-256: ${manifest.sha256}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMacOSNotifier();
}
