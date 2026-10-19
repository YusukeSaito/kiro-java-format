---
inclusion: auto
---

# Java formatting via the Oracle Java extension

A CLI command named `kiro-java-format` is installed on this machine. It formats
`.java` files and organizes their imports using the exact engine from the installed
Oracle Java extension (`oracle.oracle-java`) — the same one the editor uses for
"Format Document" and "Organize Imports".

## When to use it

When the user asks to format / reformat / 整形 a Java file or set of Java files
from chat, run this command instead of hand-editing whitespace.

Also run it when imports need tidying (unused imports, `.*` imports, group order).
Do not hand-edit an import block: the command reads the project's code style
(`nb-configuration.xml` for Maven) and the editor would disagree with a manual edit.

## Usage

**Pass all the files in one invocation.** Each call starts a JVM, so one call is
much faster than a loop.

```bash
# Format files in place (imports are organized too)
kiro-java-format src/main/java/com/example/Foo.java src/main/java/com/example/Bar.java

# Format every changed Java file in one call
kiro-java-format $(git diff --name-only --diff-filter=d -- '*.java')

# Check only (exit code 1 if any file would change), don't write
kiro-java-format --check src/main/java/com/example/Foo.java

# Format but leave the import block alone
kiro-java-format --no-organize-imports src/main/java/com/example/Foo.java
```

Useful options: `--root <dir>` to set the project root, `--tab-size <n>`,
`--use-tabs`, `--timeout <sec>`, `-v` for diagnostics.

## Notes

- The first run in a project is slow (JVM start and indexing). Projects that index
  slowly get a per-project cached index, so later runs are faster. Parallel calls and
  repeated files are safe, but prefer one call with all the files: it is faster, and
  parallel runs are not used to decide whether a project gets the cache.
- **Verify after formatting.** Compile (`./mvnw -o -q test-compile`), and confirm the
  diff is only whitespace, line breaks and imports.
- It writes changes directly to the files. Review the diff afterwards.
- **`imports skipped (file does not resolve): <path>`** means the file has compile
  errors, so the import block was left alone (organizing it would delete the imports
  of everything that does not resolve). Formatting still ran. Fix the errors and
  re-run, or accept the imports as they are. Once indexing has finished, a file that
  still has errors is reported this way after about two seconds instead of waiting a
  minute. Files that use Lombok usually end up here.
- Organizing imports can change many lines in a file that used `.*` imports. Keep
  that in a commit of its own, separate from logic changes.
- If the command is not found, the tool is not installed on this machine; see the
  kiro-java-format README for installation.
