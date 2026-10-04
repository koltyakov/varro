# Thumbnail runtime and distribution

## Runtime

Thumbnails use `@imagemagick/magick-wasm` 0.0.44 in a lazy Node worker inside a shared helper process.
Windows for the same extension installation/build and OS account reuse that process, even when their
extension hosts and sessions are separate. Remote hosts have their own helper on the remote machine.
Extension hosts neither load WASM nor decode base64 originals for thumbnail requests.
The same wasm32 binary runs in supported desktop and remote Node extension hosts. The upstream `x86`
directory names the WASM memory model, not a host CPU requirement. Varro does not use the wasm64 build,
native addons, external ImageMagick executables, runtime downloads or browser-only APIs.

The worker accepts embedded PNG, JPEG, WebP, GIF and AVIF bytes. It generates a WebP poster frame with
the longest edge at most 384 pixels and output at most 256 KiB. It applies EXIF orientation, preserves
alpha and small RGB color profiles, and removes other metadata. Unsupported or damaged inputs retain
a placeholder; they never fall back to sending the original inline.

Requests are serialized, limited to 24 MiB per decoded input and 64 MiB of admitted input, with at most
nine admitted requests across all windows, including the active job. Admission happens before image
upload, base64 decoding or large host-side copies. Uploads use backpressure and one transferable
encoded buffer; decoding occurs in the codec worker. The codec rejects images over 16 million pixels,
uses JPEG decoder downsampling after validating original dimensions, bounds ImageMagick allocation requests
and pixel-cache memory, and disables disk spill. A ten-second host deadline terminates stalled work.
These codec limits do not constitute a hard process RSS cap. The worker terminates after 30 seconds
idle to release its WASM heap. The helper exits after 60 seconds without admitted requests. Closing one
window cancels only that window's requests, not the shared service. A cancelled caller settles
immediately; active work gets up to 250 ms to finish before termination, avoiding restart churn for
nearly-complete conversions. The helper retains the compiled WASM module across worker replacements.

The cache is **memory-only**, at most 64 successful previews and 4 MiB of accounted string storage per
view and another shared cache of the same size, with a fixed five-minute TTL. Content hashes deduplicate
conversions across windows and reference IDs without retaining originals. Hits do not extend expiry. A one-minute sweep removes unused expired
entries. Disposal clears the cache. Failures are not cached. Missing entries always regenerate from
the persisted original, regardless of which OpenCode client created the session. There is no disk cache.
Any future disk cache must have fixed read-enforced expiry, automatic startup and periodic garbage
collection, a byte limit and stale temporary-file cleanup; cache availability must not affect correctness.

The helper listens only on loopback. A private credential under Varro's `thumbnails` state directory
authenticates both peers, with build-specific HMAC keys. Each upload waits for a signed `100 Continue`
on the same connection before sending image bytes. Deterministic candidate ports and exclusive bind
arbitrate simultaneous starts; losing helpers exit before loading WASM. There are no PID locks to
repair and no unrelated processes are stopped. Different builds and isolated test roots cannot reuse
each other's service. The persistent credential is not an image cache. Missing or dead helpers restart
on demand, with bounded startup, upload and conversion deadlines.

`npm run test:ai-runner` includes historical PNG/JPEG base64 attachments and a streamed GIF attachment
in its isolated editor replay. Snapshots verify actual decoded WebP thumbnails at 384×216, rather than
counting placeholders or assuming that deferred tool screenshots were displayed. Cross-process tests
also verify simultaneous startup, independent client cancellation, idle restart, and refusal to upload
to a replacement listener without its proof. These checks do not establish a resolution of issue #36's
reported long-session freeze or replace Windows/Linux visual testing.

## VSIX and marketplaces

`npm run build:extension` bundles the worker separately, copies the single WASM asset and upstream
licenses, verifies unresolved imports, and performs a cold conversion. `npm run package:vsix` repeats
the conversion in a temporary staging directory containing only files allowed by `package.json`.
Neither build nor packaging needs native compilation. Package without `--target` to retain one
universal VSIX for desktop and remote hosts; this is not a vscode.dev web extension.

[VS Code Marketplace publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
supports universal VSIX packages. [Open VSX publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions)
accepts the same prebuilt VSIX and uses VSCE for packaging. Neither published guide prohibits bundled
WebAssembly. Passing local packaging checks is not a registry approval: both services can scan and
reject uploads, and publisher accounts and agreements still apply. This implementation does not publish.

## Third-party licensing and source

The WASM includes ImageMagick and delegates with their own licenses, including LGPL libraries.
Varro's MIT license does not replace those licenses. Every VSIX includes:

- `dist/extension/thumbnail-LICENSE.txt`: magick-wasm's Apache-2.0 license.
- `dist/extension/thumbnail-NOTICE.txt`: the complete upstream attribution and license file,
  including ImageMagick, delegate copyright notices and applicable LGPL/GPL texts.
- `NOTICES.md` and this document: attribution, source access and replacement instructions.

The wrapper JavaScript is bundled and minified, and the upstream WASM is copied without modification.
Source and build materials corresponding to this pinned release are publicly available without charge:

- [magick-wasm 0.0.44 source](https://github.com/dlemstra/magick-wasm/tree/0.0.44),
  [source archive](https://github.com/dlemstra/magick-wasm/archive/refs/tags/0.0.44.tar.gz).
- [Magick.Native 2026.927.1314 source and build scripts](https://github.com/dlemstra/Magick.Native/tree/999720f7ebe03d5a0029536f1586a2cb82b500ae),
  [source archive](https://github.com/dlemstra/Magick.Native/archive/999720f7ebe03d5a0029536f1586a2cb82b500ae.tar.gz).
- [ImageMagick source at the commit pinned by Magick.Native](https://github.com/ImageMagick/ImageMagick/tree/ad98b244c995d2e3051757fa3b7855f45b550d24),
  [source archive](https://github.com/ImageMagick/ImageMagick/archive/ad98b244c995d2e3051757fa3b7855f45b550d24.tar.gz).
- [Dependency release 2026.09.26.1516](https://github.com/ImageMagick/Dependencies/releases/tag/2026.09.26.1516),
  [dependency source checkout and build recipes](https://github.com/ImageMagick/Dependencies/tree/2026.09.26.1516).
  Its checkout script obtains each delegate's source at the recorded revision. The source archives of
  the parent repositories alone do not contain all delegate sources.

For library changes, follow the pinned Magick.Native workflow's `wasm` job, using architecture `x86`,
Q8 and Emscripten 6.0.6. Build modified delegates using the dependency release's WASM recipes instead
of downloading its prebuilt static archive, then build ImageMagick and Magick.Native against them.
The upstream build instructions and workflow are included in the linked source tree. Keep the exported
API compatible with magick-wasm 0.0.44, or rebuild the wrapper and Varro worker together.

To use a compatible modified library, replace `dist/extension/thumbnail-codec.wasm` in an unpacked
extension and reload the extension host. Varro does not impose signatures, checksums or account checks
on library replacements. Modification for personal use and reverse engineering to debug modifications
to LGPL-covered components are not restricted by Varro. Varro's worker and integration source are
available in [the Varro repository](https://github.com/koltyakov/varro).

On a dependency update, recheck the source revisions, delegate terms and replacement procedure; retain
source availability for distributed versions. Do not describe the whole WASM binary as Apache-only.
