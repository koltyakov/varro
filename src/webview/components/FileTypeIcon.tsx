import cIcon from 'material-icon-theme/icons/c.svg';
import cppIcon from 'material-icon-theme/icons/cpp.svg';
import csharpIcon from 'material-icon-theme/icons/csharp.svg';
import cssIcon from 'material-icon-theme/icons/css.svg';
import dartIcon from 'material-icon-theme/icons/dart.svg';
import audioIcon from 'material-icon-theme/icons/audio.svg';
import databaseIcon from 'material-icon-theme/icons/database.svg';
import dockerIcon from 'material-icon-theme/icons/docker.svg';
import fileIcon from 'material-icon-theme/icons/file.svg';
import gitIcon from 'material-icon-theme/icons/git.svg';
import goIcon from 'material-icon-theme/icons/go.svg';
import graphqlIcon from 'material-icon-theme/icons/graphql.svg';
import htmlIcon from 'material-icon-theme/icons/html.svg';
import imageIcon from 'material-icon-theme/icons/image.svg';
import javaIcon from 'material-icon-theme/icons/java.svg';
import javascriptIcon from 'material-icon-theme/icons/javascript.svg';
import jsonIcon from 'material-icon-theme/icons/json.svg';
import kotlinIcon from 'material-icon-theme/icons/kotlin.svg';
import lessIcon from 'material-icon-theme/icons/less.svg';
import licenseIcon from 'material-icon-theme/icons/license.svg';
import lockIcon from 'material-icon-theme/icons/lock.svg';
import luaIcon from 'material-icon-theme/icons/lua.svg';
import makefileIcon from 'material-icon-theme/icons/makefile.svg';
import markdownIcon from 'material-icon-theme/icons/markdown.svg';
import pdfIcon from 'material-icon-theme/icons/pdf.svg';
import perlIcon from 'material-icon-theme/icons/perl.svg';
import phpIcon from 'material-icon-theme/icons/php.svg';
import powershellIcon from 'material-icon-theme/icons/powershell.svg';
import pythonIcon from 'material-icon-theme/icons/python.svg';
import rIcon from 'material-icon-theme/icons/r.svg';
import reactIcon from 'material-icon-theme/icons/react.svg';
import reactTsIcon from 'material-icon-theme/icons/react_ts.svg';
import rubyIcon from 'material-icon-theme/icons/ruby.svg';
import rustIcon from 'material-icon-theme/icons/rust.svg';
import sassIcon from 'material-icon-theme/icons/sass.svg';
import shellIcon from 'material-icon-theme/icons/console.svg';
import svelteIcon from 'material-icon-theme/icons/svelte.svg';
import svgIcon from 'material-icon-theme/icons/svg.svg';
import swiftIcon from 'material-icon-theme/icons/swift.svg';
import terraformIcon from 'material-icon-theme/icons/terraform.svg';
import tomlIcon from 'material-icon-theme/icons/toml.svg';
import tsconfigIcon from 'material-icon-theme/icons/tsconfig.svg';
import typescriptIcon from 'material-icon-theme/icons/typescript.svg';
import vueIcon from 'material-icon-theme/icons/vue.svg';
import videoIcon from 'material-icon-theme/icons/video.svg';
import xmlIcon from 'material-icon-theme/icons/xml.svg';
import yamlIcon from 'material-icon-theme/icons/yaml.svg';
import zipIcon from 'material-icon-theme/icons/zip.svg';
import { getLeafPathName } from '../lib/path-display';

const FILE_NAME_ICONS = new Map<string, string>(
  Object.entries({
    '.dockerignore': dockerIcon,
    '.gitattributes': gitIcon,
    '.gitignore': gitIcon,
    dockerfile: dockerIcon,
    'go.mod': goIcon,
    'go.sum': goIcon,
    license: licenseIcon,
    makefile: makefileIcon,
    'package-lock.json': lockIcon,
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

export function hasRecognizedFileType(path: string): boolean {
  const filename = getLeafPathName(path).toLowerCase();
  if (FILE_NAME_ICONS.has(filename)) return true;

  const dotIndex = filename.lastIndexOf('.');
  return dotIndex >= 0 && FILE_EXTENSION_ICONS.has(filename.slice(dotIndex + 1));
}

export function getFileTypeIcon(path: string | undefined): string {
  if (!path) return fileIcon;

  const filename = getLeafPathName(path).toLowerCase();
  const namedIcon = FILE_NAME_ICONS.get(filename);
  if (namedIcon) return namedIcon;

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === filename.length - 1) return fileIcon;
  return FILE_EXTENSION_ICONS.get(filename.slice(dotIndex + 1)) ?? fileIcon;
}

export function createFileTypeIconElement(
  path: string | undefined,
  className = 'file-path-icon'
): HTMLImageElement {
  const icon = document.createElement('img');
  icon.className = `file-type-icon ${className}`;
  icon.src = getFileTypeIcon(path);
  icon.alt = '';
  icon.setAttribute('aria-hidden', 'true');
  icon.draggable = false;
  return icon;
}

export function FileTypeIcon(props: { path?: string; class?: string }) {
  return (
    <img
      class={props.class ? `file-type-icon ${props.class}` : 'file-type-icon'}
      src={getFileTypeIcon(props.path)}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
