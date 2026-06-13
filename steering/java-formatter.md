---
inclusion: auto
---

# Java formatting via the Oracle Java extension

A CLI command named `kiro-java-format` is installed on this machine. It formats
`.java` files using the exact formatter from the installed Oracle Java extension
(`oracle.oracle-java`) — the same engine the editor uses for "Format Document".

## When to use it

When the user asks to format / reformat / 整形 a Java file or set of Java files
from chat, run this command instead of hand-editing whitespace.

## Usage

```bash
# Format one or more files in place
kiro-java-format src/main/java/com/example/Foo.java

# Format several files
kiro-java-format $(git diff --name-only '*.java')

# Check only (exit code 1 if any file would change), don't write
kiro-java-format --check src/main/java/com/example/Foo.java
```

Useful options: `--root <dir>` to set the project root, `--tab-size <n>`,
`--use-tabs`, `--timeout <sec>`, `-v` for diagnostics.

## Notes

- The first run is slow (the language server JVM has to start). Subsequent files
  in the same invocation are fast, so pass multiple files in one call.
- It writes changes directly to the files. Review the diff afterwards.
- If the command is not found, the tool is not installed on this machine; see the
  kiro-java-format README for installation.
