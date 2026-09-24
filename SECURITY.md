# Security policy

## Report a problem

Please do not open a public issue for a security problem. Use the private report form of this repository instead: **Security → Report a vulnerability** on GitHub. Say what you found, how to reproduce it, and which version or commit you used.

You will get an answer within seven days.

## What counts

The plugin runs hooks inside Claude Code and starts the Codex CLI. These are in scope:

- A way to make the plugin run a command, read a file or send data that the user did not ask for.
- A way for a brief, a repository file or another session to change what a Codex job does or where it writes.
- A way for the TypeSafe key or a Codex login to reach a log, a prompt or another program.
- A way to spend Codex credits while `codexSpendCredits` is `false`.

What the plugin sends to TypeSafe and to OpenAI by design is listed in the README under "What leaves your machine".
