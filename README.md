# kiro-java-format

Format `.java` files from the command line using the **exact same formatter** as the
[Oracle Java extension](https://marketplace.visualstudio.com/items?itemName=Oracle.oracle-java)
(`oracle.oracle-java`) for VS Code / [Kiro](https://kiro.dev).

If you already use that extension in your editor, this gives you the identical
formatting on the command line and in CI — no second formatter to configure, no
style drift between "Format Document" and your build.

> **Unofficial.** This is a community tool. It is not affiliated with, endorsed by,
> or supported by Oracle. It simply drives the language server that ships inside the
> extension you already have installed.

## How it works

The extension bundles a Java language server (`nbcode`, based on Apache NetBeans).
This tool:

1. Finds the installed `oracle.oracle-java` extension and its `nbcode` launcher.
2. Starts it as a language server (`nbcode --start-java-language-server=listen-hash:0`).
3. Connects over a local socket and performs the auth handshake.
4. Speaks LSP: `initialize` → `didOpen` → `source.organizeImports` code action →
   `textDocument/formatting`, applies the returned edits to the file, then `shutdown`.
   Given several files, it opens up to 16 at once so the server checks them side by
   side; each is still organized, formatted and written one at a time, in the order given.

It is a single dependency-free Node script — nothing is installed globally except a
small symlink.

Each invocation starts its own language server and stops it when done. For a project
whose index takes a while to build (10 seconds or more), the index is kept in a cache
per project, so later runs of that project index faster (see [Cache](#cache)). Smaller
projects index from scratch every time, which is quicker for them.

## Imports

Imports are organized before formatting, the same as the editor's **Organize Imports**:
unused imports are dropped, `.*` imports are expanded or collapsed, and the block is
grouped and sorted. Pass `--no-organize-imports` to format only.

Both steps read your project's code style, so the result matches the editor. For Maven
projects that is `nb-configuration.xml` at the project root, for example:

```xml
<project-shared-configuration>
    <properties xmlns="http://www.netbeans.org/ns/maven-properties-data/1">
        <org-netbeans-modules-editor-indent.CodeStyle.usedProfile>project</org-netbeans-modules-editor-indent.CodeStyle.usedProfile>
        <!-- group order; an entry starting with `static ` takes the static imports,
             and `*` takes whatever matched no other group -->
        <org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.importGroupsOrder>java;javax;org;com;*;static *</org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.importGroupsOrder>
        <!-- never collapse to `.*` -->
        <org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.countForUsingStarImport>999</org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.countForUsingStarImport>
        <org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.countForUsingStaticStarImport>999</org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.countForUsingStaticStarImport>
        <org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.allowConvertToStarImport>true</org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.allowConvertToStarImport>
        <org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.allowConvertToStaticStarImport>true</org-netbeans-modules-editor-indent.text.x-java.CodeStyle.project.allowConvertToStaticStarImport>
    </properties>
</project-shared-configuration>
```

`usedProfile` must be `project`, otherwise none of the other keys are read.

### Files that do not compile keep their imports

Organizing rebuilds the import block from the types the compiler can resolve, so a type
it cannot see loses its import. The tool therefore waits for the server to report the
file as error-free and **skips organizing** if it is not, printing:

```
imports skipped (file does not resolve): src/main/java/com/example/Foo.java
```

Formatting still runs. The first file in a run waits for the project's classpath to
load, so it takes longer than the rest. Once the project has been indexed, a file that
still has errors is reported this way after about two seconds. When the index comes from
the cache, the tool first waits for indexing to finish, so that a stale index cannot
decide for it. Files with real compile errors are always reported this way — fix the
errors, or pass `--no-organize-imports`.

## Requirements

- The **Oracle Java extension** installed in Kiro or VS Code. The tool auto-detects it
  under `~/.kiro/extensions`, `~/.vscode/extensions`, `~/.vscode-oss/extensions`, and
  `~/.vscode-insiders/extensions`.
- **Node.js 16+**.
- A **JDK 17+** to run the language server. Auto-detected via `JAVA_HOME` / `JDK_HOME` /
  `/usr/libexec/java_home` (macOS) / `java` on `PATH`, or pass `--jdkhome`.

## Install

```bash
git clone https://github.com/YusukeSaito/kiro-java-format.git
cd kiro-java-format
bash install.sh
```

`install.sh` is idempotent and needs no sudo. It:

1. Symlinks the `kiro-java-format` command into a directory already on your `PATH`
   (prefers `~/.local/bin`), so it works from every terminal and every editor window.
2. Installs a user-level Kiro steering file at `~/.kiro/steering/java-formatter.md` so
   the Kiro agent automatically knows the command and uses it when you ask it to format
   Java. (Harmless if you do not use Kiro — it is just a markdown note.)

Verify:

```bash
kiro-java-format --help
```

### Without the installer

The tool runs directly with Node, so you can skip `install.sh` entirely:

```bash
node /path/to/kiro-java-format/format-java.js MyClass.java
```

### Platform support

- **macOS / Linux:** fully supported, including `install.sh`.
- **Windows:** the formatter script itself supports Windows (it uses `nbcode64.exe`),
  but `install.sh` and the `bin/kiro-java-format` wrapper are Bash. Run them under Git
  Bash / WSL, or invoke `node format-java.js ...` directly from PowerShell/cmd.

## Usage

```bash
# Format files in place
kiro-java-format src/main/java/com/example/Foo.java src/main/java/com/example/Bar.java

# Only the changed Java files in a git repo
kiro-java-format $(git diff --name-only --diff-filter=d '*.java')

# Format an entire tree
find src -name '*.java' -print0 | xargs -0 kiro-java-format

# Check only: no writes, exit 1 if anything is not already formatted (great for CI)
find src -name '*.java' -print0 | xargs -0 kiro-java-format --check
```

> **Tip:** every invocation boots the language server JVM and loads the project's
> classpath. Pass **many files in one invocation** to pay that startup cost once.
> Running several invocations in parallel, or passing the same file twice, is safe.

### Options

| Option | Description |
| --- | --- |
| `--root <dir>` | Project root to open. Defaults to the nearest `pom.xml` / `build.gradle` / `.git`, else the file's directory. |
| `--jdkhome <dir>` | JDK 17+ home used to run the language server. Auto-detected if omitted. |
| `--tab-size <n>` | Indent size hint (default `4`). |
| `--use-tabs` | Indent with tabs instead of spaces. |
| `--check` | Don't write; exit `1` if any file would change. |
| `--no-organize-imports` | Only format; leave the import block alone. |
| `--timeout <sec>` | Max seconds for each wait on the server: starting it, each request, and each file's wait for the project to load (default `120`). |
| `-v`, `--verbose` | Print server / protocol diagnostics. |
| `-h`, `--help` | Show help. |

### Environment overrides

| Variable | Purpose |
| --- | --- |
| `KIRO_JAVA_EXT` | Path to the extension dir (the one containing `nbcode/`). Use this if auto-detection fails. |
| `KIRO_JAVA_JDKHOME` | JDK home (same as `--jdkhome`). |
| `KIRO_JAVA_FORMAT_CACHE` | Cache directory for the language server's index (see [Cache](#cache)). |

## Cache

The tool keeps a small record per project (project root + extension + JDK): how long its
index took to build from scratch. A project that took 10 seconds or more also gets its
index cached, about 100 MB per project; smaller projects never get one. Until a project
has been measured, every run builds its index from scratch.

Only a run that had the project to itself is measured, since indexes built side by side
slow each other down. A run is not measured when another invocation on the same project
root was running while it indexed, or when it built a temporary index because another
invocation was using the cached one.

| OS | Location |
| --- | --- |
| macOS | `~/Library/Caches/kiro-java-format/<hash>` |
| Linux | `${XDG_CACHE_HOME:-~/.cache}/kiro-java-format/<hash>` |
| Windows | `%LOCALAPPDATA%\kiro-java-format\<hash>` |

`KIRO_JAVA_FORMAT_CACHE` replaces the `kiro-java-format` directory above.

One invocation at a time uses a project's cached index; one that starts while another is
still running builds a temporary index instead. To clear the cache, make sure no
`kiro-java-format` is running, then delete the `kiro-java-format` directory.

## CI example (GitHub Actions)

CI needs the extension's `nbcode` available. Point `KIRO_JAVA_EXT` at an unpacked copy
of the extension (e.g. checked into your repo or downloaded in a setup step), then:

```yaml
- uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: '17'
- uses: actions/setup-node@v4
  with:
    node-version: '20'
- name: Check Java formatting
  env:
    KIRO_JAVA_EXT: ${{ github.workspace }}/.tools/oracle-java-ext
  run: |
    find src -name '*.java' -print0 | xargs -0 node kiro-java-format/format-java.js --check
```

## Editor parity

Output matches the extension's "Format Document". One thing to note: for files with
**no `package` declaration**, the NetBeans formatter inserts a single blank line before
the top-level type (its default "blank line before class"). This is the same result the
editor produces. Real-world files with a `package` line are unaffected.

## Troubleshooting

- **"Could not find the Oracle Java extension"** — install it in Kiro/VS Code, or set
  `KIRO_JAVA_EXT` to the directory that contains `nbcode/`.
- **"Timed out waiting for the language server"** — the JVM may be slow to start on first
  run, or a wrong JDK was picked. Re-run with `-v` and/or raise `--timeout`, and pass
  `--jdkhome` to a JDK 17+. `--timeout` limits each wait, not the whole run: when the
  server does not start in time the run stops; when one file's request times out, that
  file is reported (`error: <file>: Timed out ...`), left unwritten, and the run goes on.
- **Leftover `kiro-java-format-userdir-*` directories in your temp directory** — older
  versions could leave them behind. They are safe to delete by hand.
- **`kiro-java-format: command not found`** — your chosen bin dir isn't on `PATH`. The
  installer prints the directory; add it to `PATH` (e.g. `export PATH="$HOME/.local/bin:$PATH"`).

## Contributing

Issues and pull requests are welcome. The whole tool is one small script
(`format-java.js`) plus a Bash wrapper and installer, so it's easy to hack on. Please
keep it dependency-free.

## License

Copyright (c) 2026 SAITO Yusuke, Mirai-souzou inc.

Licensed under [Apache-2.0](LICENSE). The Oracle Java extension and its bundled `nbcode`
are separate software with their own license; this project does not redistribute them —
it only invokes a copy you have already installed.

## Acknowledgements

Built on the language server from the
[Oracle Java Platform extension for VS Code](https://github.com/oracle/javavscode) and
Apache NetBeans.
