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
4. Speaks LSP: `initialize` → `didOpen` → `textDocument/formatting`, applies the
   returned edits to the file, then `shutdown`.

It is a single dependency-free Node script — nothing is installed globally except a
small symlink.

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

> **Tip:** the first file is slow because the language server JVM has to boot. Pass
> **many files in one invocation** to amortize that startup cost — don't call the
> command once per file in a loop.

### Options

| Option | Description |
| --- | --- |
| `--root <dir>` | Project root to open. Defaults to the nearest `pom.xml` / `build.gradle` / `.git`, else the file's directory. |
| `--jdkhome <dir>` | JDK 17+ home used to run the language server. Auto-detected if omitted. |
| `--tab-size <n>` | Indent size hint (default `4`). |
| `--use-tabs` | Indent with tabs instead of spaces. |
| `--check` | Don't write; exit `1` if any file would change. |
| `--timeout <sec>` | Max seconds to wait for the server (default `120`). |
| `-v`, `--verbose` | Print server / protocol diagnostics. |
| `-h`, `--help` | Show help. |

### Environment overrides

| Variable | Purpose |
| --- | --- |
| `KIRO_JAVA_EXT` | Path to the extension dir (the one containing `nbcode/`). Use this if auto-detection fails. |
| `KIRO_JAVA_JDKHOME` | JDK home (same as `--jdkhome`). |

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
  `--jdkhome` to a JDK 17+.
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
