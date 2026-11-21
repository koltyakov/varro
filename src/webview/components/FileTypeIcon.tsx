import cIcon from 'material-icon-theme/icons/c.svg?raw';
import cppIcon from 'material-icon-theme/icons/cpp.svg?raw';
import csharpIcon from 'material-icon-theme/icons/csharp.svg?raw';
import contributingIcon from 'material-icon-theme/icons/contributing.svg?raw';
import cssIcon from 'material-icon-theme/icons/css.svg?raw';
import dartIcon from 'material-icon-theme/icons/dart.svg?raw';
import audioIcon from 'material-icon-theme/icons/audio.svg?raw';
import databaseIcon from 'material-icon-theme/icons/database.svg?raw';
import dockerIcon from 'material-icon-theme/icons/docker.svg?raw';
import editorconfigIcon from 'material-icon-theme/icons/editorconfig.svg?raw';
import fileIcon from 'material-icon-theme/icons/file.svg?raw';
import gemfileIcon from 'material-icon-theme/icons/gemfile.svg?raw';
import gitIcon from 'material-icon-theme/icons/git.svg?raw';
import goIcon from 'material-icon-theme/icons/go.svg?raw';
import goModIcon from 'material-icon-theme/icons/go-mod.svg?raw';
import gradleIcon from 'material-icon-theme/icons/gradle.svg?raw';
import graphqlIcon from 'material-icon-theme/icons/graphql.svg?raw';
import htmlIcon from 'material-icon-theme/icons/html.svg?raw';
import imageIcon from 'material-icon-theme/icons/image.svg?raw';
import javaIcon from 'material-icon-theme/icons/java.svg?raw';
import javascriptIcon from 'material-icon-theme/icons/javascript.svg?raw';
import jsonIcon from 'material-icon-theme/icons/json.svg?raw';
import kotlinIcon from 'material-icon-theme/icons/kotlin.svg?raw';
import lessIcon from 'material-icon-theme/icons/less.svg?raw';
import licenseIcon from 'material-icon-theme/icons/license.svg?raw';
import lockIcon from 'material-icon-theme/icons/lock.svg?raw';
import luaIcon from 'material-icon-theme/icons/lua.svg?raw';
import makefileIcon from 'material-icon-theme/icons/makefile.svg?raw';
import markdownIcon from 'material-icon-theme/icons/markdown.svg?raw';
import mavenIcon from 'material-icon-theme/icons/maven.svg?raw';
import nodeIcon from 'material-icon-theme/icons/nodejs.svg?raw';
import npmIcon from 'material-icon-theme/icons/npm.svg?raw';
import pdfIcon from 'material-icon-theme/icons/pdf.svg?raw';
import perlIcon from 'material-icon-theme/icons/perl.svg?raw';
import phpIcon from 'material-icon-theme/icons/php.svg?raw';
import powershellIcon from 'material-icon-theme/icons/powershell.svg?raw';
import pythonMiscIcon from 'material-icon-theme/icons/python-misc.svg?raw';
import pythonIcon from 'material-icon-theme/icons/python.svg?raw';
import rIcon from 'material-icon-theme/icons/r.svg?raw';
import readmeIcon from 'material-icon-theme/icons/readme.svg?raw';
import reactIcon from 'material-icon-theme/icons/react.svg?raw';
import reactTsIcon from 'material-icon-theme/icons/react_ts.svg?raw';
import rubyIcon from 'material-icon-theme/icons/ruby.svg?raw';
import rustIcon from 'material-icon-theme/icons/rust.svg?raw';
import sassIcon from 'material-icon-theme/icons/sass.svg?raw';
import shellIcon from 'material-icon-theme/icons/console.svg?raw';
import svelteIcon from 'material-icon-theme/icons/svelte.svg?raw';
import svgIcon from 'material-icon-theme/icons/svg.svg?raw';
import swiftIcon from 'material-icon-theme/icons/swift.svg?raw';
import terraformIcon from 'material-icon-theme/icons/terraform.svg?raw';
import tomlIcon from 'material-icon-theme/icons/toml.svg?raw';
import tsconfigIcon from 'material-icon-theme/icons/tsconfig.svg?raw';
import typescriptIcon from 'material-icon-theme/icons/typescript.svg?raw';
import vueIcon from 'material-icon-theme/icons/vue.svg?raw';
import videoIcon from 'material-icon-theme/icons/video.svg?raw';
import xmlIcon from 'material-icon-theme/icons/xml.svg?raw';
import yamlIcon from 'material-icon-theme/icons/yaml.svg?raw';
import zipIcon from 'material-icon-theme/icons/zip.svg?raw';
import { getLeafPathName } from '../lib/path-display';

const FILE_NAME_ICONS = new Map<string, string>(
  Object.entries({
    '.dockerignore': dockerIcon,
    '.editorconfig': editorconfigIcon,
    '.gitattributes': gitIcon,
    '.gitignore': gitIcon,
    '.npmrc': npmIcon,
    '.nvmrc': nodeIcon,
    'compose.yaml': dockerIcon,
    'compose.yml': dockerIcon,
    contributing: contributingIcon,
    'contributing.md': contributingIcon,
    'docker-compose.yaml': dockerIcon,
    'docker-compose.yml': dockerIcon,
    dockerfile: dockerIcon,
    gemfile: gemfileIcon,
    'go.mod': goModIcon,
    'go.sum': goModIcon,
    'gradle.properties': gradleIcon,
    'gradle-wrapper.properties': gradleIcon,
    gradlew: gradleIcon,
    'gradlew.bat': gradleIcon,
    license: licenseIcon,
    makefile: makefileIcon,
    'package-lock.json': lockIcon,
    'package.json': nodeIcon,
    'pom.xml': mavenIcon,
    'pyproject.toml': pythonMiscIcon,
    readme: readmeIcon,
    'readme.md': readmeIcon,
    'requirements.txt': pythonMiscIcon,
    'tsconfig.json': tsconfigIcon,
  })
);

const FILE_EXTENSION_ICONS = new Map<string, string>(
  Object.entries({
    avif: imageIcon,
    aac: audioIcon,
    bash: shellIcon,
    bmp: imageIcon,
    c: cIcon,
    cc: cppIcon,
    cjs: javascriptIcon,
    cpp: cppIcon,
    cs: csharpIcon,
    css: cssIcon,
    cts: typescriptIcon,
    csv: databaseIcon,
    dart: dartIcon,
    db: databaseIcon,
    gif: imageIcon,
    git: gitIcon,
    go: goIcon,
    gradle: gradleIcon,
    gql: graphqlIcon,
    graphql: graphqlIcon,
    h: cIcon,
    hpp: cppIcon,
    htm: htmlIcon,
    html: htmlIcon,
    ico: imageIcon,
    java: javaIcon,
    jpeg: imageIcon,
    jpg: imageIcon,
    js: javascriptIcon,
    json: jsonIcon,
    jsonc: jsonIcon,
    jsx: reactIcon,
    kt: kotlinIcon,
    kts: kotlinIcon,
    less: lessIcon,
    lock: lockIcon,
    lua: luaIcon,
    md: markdownIcon,
    mdx: markdownIcon,
    mjs: javascriptIcon,
    mkv: videoIcon,
    mov: videoIcon,
    mp3: audioIcon,
    mp4: videoIcon,
    mts: typescriptIcon,
    ogg: audioIcon,
    pdf: pdfIcon,
    php: phpIcon,
    pl: perlIcon,
    png: imageIcon,
    ps1: powershellIcon,
    py: pythonIcon,
    pyi: pythonIcon,
    r: rIcon,
    rb: rubyIcon,
    rs: rustIcon,
    sass: sassIcon,
    scss: sassIcon,
    sh: shellIcon,
    sqlite: databaseIcon,
    sql: databaseIcon,
    svelte: svelteIcon,
    svg: svgIcon,
    swift: swiftIcon,
    tar: zipIcon,
    tf: terraformIcon,
    tfvars: terraformIcon,
    toml: tomlIcon,
    ts: typescriptIcon,
    tsx: reactTsIcon,
    vue: vueIcon,
    webp: imageIcon,
    wav: audioIcon,
    webm: videoIcon,
    xml: xmlIcon,
    yaml: yamlIcon,
    yml: yamlIcon,
    zip: zipIcon,
  })
);

// Visible artwork bounds as fractions of the square SVG canvas, measured at 1024px.
// Reserve the final geometry before image loading; no runtime canvas or layout reads.
const ICON_INK_BOUNDS = new Map<
  string,
  readonly [left: number, top: number, right: number, bottom: number]
>([
  [audioIcon, [0.0625, 0.0625, 0.9375, 0.9375]],
  [cIcon, [0.25, 0.0625, 0.75, 0.875]],
  [contributingIcon, [0.125, 0.04102, 0.875, 0.875]],
  [cppIcon, [0.0625, 0.0625, 1, 0.875]],
  [csharpIcon, [0.0625, 0.0625, 0.9375, 0.875]],
  [cssIcon, [0.125, 0.125, 0.875, 0.875]],
  [dartIcon, [0.0625, 0.0625, 0.9375, 0.9375]],
  [databaseIcon, [0.1875, 0.125, 0.8125, 0.875]],
  [dockerIcon, [0.08301, 0.20117, 0.91699, 0.79883]],
  [editorconfigIcon, [0.08594, 0.10059, 0.91309, 0.89941]],
  [fileIcon, [0.16602, 0.08301, 0.83398, 0.91699]],
  [gemfileIcon, [0.0625, 0, 0.9375, 1]],
  [gitIcon, [0.05176, 0.05176, 0.94824, 0.94824]],
  [goIcon, [0, 0.3125, 1, 0.71875]],
  [goModIcon, [0, 0.3125, 1, 0.71875]],
  [gradleIcon, [0.0625, 0.125, 0.9375, 0.875]],
  [graphqlIcon, [0.125, 0.0625, 0.875, 0.9375]],
  [htmlIcon, [0.125, 0.125, 0.875, 0.875]],
  [imageIcon, [0.15527, 0.0625, 0.84375, 0.9375]],
  [javaIcon, [0.125, 0.125, 0.9375, 0.875]],
  [javascriptIcon, [0.125, 0.125, 0.875, 0.875]],
  [jsonIcon, [0.08301, 0.16602, 0.91699, 0.83398]],
  [kotlinIcon, [0.12305, 0.12402, 0.87695, 0.87598]],
  [lessIcon, [0.125, 0.125, 0.875, 0.875]],
  [licenseIcon, [0.15625, 0.0625, 0.84375, 0.9375]],
  [lockIcon, [0.1875, 0.0625, 0.8125, 0.9375]],
  [luaIcon, [0.0625, 0.0625, 0.9375, 0.9375]],
  [makefileIcon, [0.0625, 0.125, 0.92969, 0.9375]],
  [markdownIcon, [0.125, 0.3125, 0.9375, 0.75]],
  [mavenIcon, [0.08301, 0.08301, 0.91699, 0.91699]],
  [nodeIcon, [0.125, 0.09375, 0.875, 0.96875]],
  [npmIcon, [0.125, 0.125, 0.875, 0.875]],
  [pdfIcon, [0.16602, 0.08301, 0.83398, 0.91699]],
  [perlIcon, [0.16699, 0.06641, 0.83301, 0.93359]],
  [phpIcon, [0, 0.24609, 1, 0.75391]],
  [powershellIcon, [0.0625, 0.1875, 0.9375, 0.8125]],
  [pythonIcon, [0.08301, 0.08301, 0.91699, 0.91699]],
  [pythonMiscIcon, [0.125, 0.0625, 1, 0.9375]],
  [reactIcon, [0.06152, 0.10938, 0.9375, 0.89063]],
  [reactTsIcon, [0.06152, 0.10938, 0.9375, 0.89063]],
  [readmeIcon, [0.06152, 0.0625, 0.9375, 0.9375]],
  [rIcon, [0.06641, 0.16797, 0.92969, 0.83398]],
  [rubyIcon, [0.12891, 0.13184, 0.87012, 0.86816]],
  [rustIcon, [0.0625, 0.0625, 0.9375, 0.9375]],
  [sassIcon, [0.12402, 0.0625, 0.875, 0.9375]],
  [shellIcon, [0.0625, 0.125, 0.9375, 0.875]],
  [svelteIcon, [0.15039, 0.08105, 0.84863, 0.91895]],
  [svgIcon, [0.0625, 0.0625, 0.9375, 0.9375]],
  [swiftIcon, [0.08301, 0.12695, 0.91699, 0.87402]],
  [terraformIcon, [0.0625, 0.0625, 0.9375, 0.9375]],
  [tomlIcon, [0.0625, 0.0625, 0.9375, 0.9375]],
  [tsconfigIcon, [0.125, 0.0625, 0.9375, 0.9375]],
  [typescriptIcon, [0.125, 0.125, 0.875, 0.875]],
  [videoIcon, [0.0625, 0.1875, 0.9375, 0.8125]],
  [vueIcon, [0.07422, 0.16016, 0.92578, 0.89453]],
  [xmlIcon, [0.16602, 0.08301, 0.83398, 0.91699]],
  [yamlIcon, [0.16602, 0.08301, 0.83398, 0.91699]],
  [zipIcon, [0.12402, 0.125, 0.875, 0.875]],
]);

const ICON_PRESENTATIONS = new Map(
  [...ICON_INK_BOUNDS].map(([svg, [left, top, right, bottom]]) => {
    const aspect = (right - left) / (bottom - top);
    // Balance artwork area, then bound both dimensions. Equal heights make wide logos dominate.
    const fill = Math.min(0.8 / Math.sqrt(aspect), 0.875, 1.25 / aspect);
    const cropped = svg.replace(/\bviewBox="([^"]+)"/, (_attribute, viewBox: string) => {
      const [x = 0, y = 0, width = 1, height = 1] = viewBox.split(/\s+/).map(Number);
      return `viewBox="${x + left * width} ${y + top * height} ${(right - left) * width} ${(bottom - top) * height}"`;
    });
    return [
      svg,
      {
        src: `data:image/svg+xml,${encodeURIComponent(cropped)}`,
        style: `--file-icon-aspect: ${aspect}; --file-icon-fill: ${fill};`,
      },
    ];
  })
);

export function hasRecognizedFileType(path: string): boolean {
  const filename = getLeafPathName(path).toLowerCase();
  if (FILE_NAME_ICONS.has(filename) || filename.endsWith('.gradle.kts')) return true;

  const dotIndex = filename.lastIndexOf('.');
  return dotIndex >= 0 && FILE_EXTENSION_ICONS.has(filename.slice(dotIndex + 1));
}

function getFileTypeIconSource(path: string | undefined): string {
  if (!path) return fileIcon;

  const filename = getLeafPathName(path).toLowerCase();
  const namedIcon = FILE_NAME_ICONS.get(filename);
  if (namedIcon) return namedIcon;
  if (filename.endsWith('.gradle.kts')) return gradleIcon;

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === filename.length - 1) return fileIcon;
  return FILE_EXTENSION_ICONS.get(filename.slice(dotIndex + 1)) ?? fileIcon;
}

function getIconPresentation(path: string | undefined) {
  const icon = ICON_PRESENTATIONS.get(getFileTypeIconSource(path));
  if (!icon) throw new Error(`Missing file icon artwork bounds for ${path ?? 'generic file'}`);
  return icon;
}

export function getFileTypeIcon(path: string | undefined): string {
  return getIconPresentation(path).src;
}

export function createFileTypeIconElement(
  path: string | undefined,
  className = 'file-path-icon'
): HTMLImageElement {
  const icon = document.createElement('img');
  icon.className = `file-type-icon ${className}`;
  const presentation = getIconPresentation(path);
  icon.src = presentation.src;
  icon.style.cssText = presentation.style;
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.draggable = false;
  return icon;
}

export function FileTypeIcon(props: { path?: string; class?: string }) {
  return (
    <img
      class={props.class ? `file-type-icon ${props.class}` : 'file-type-icon'}
      src={getIconPresentation(props.path).src}
      style={getIconPresentation(props.path).style}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
