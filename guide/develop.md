# Develop the plugin

Part of the [Subagent Router documentation](../README.md#documentation).

Clone the repository and load it for one session with a flag:

```bash
claude --plugin-dir /path/to/claude-subagent-router
```

- Do not use the flag in a project where the plugin is installed.
- After a change to the plugin files, run `/reload-plugins` in the session, or start a new one.

```bash
npm test
```

- The tests need no network and no key. They use a local stand-in for the TypeSafe API and a stand-in for the `codex` command.
- `npm run check` checks the syntax of every script.
- `npm run test:boundaries` checks the sandbox of the evaluation runner; see [EVALUATION.md](../EVALUATION.md).
- `tests/docs-links.test.mjs` fails when the README has more than 1,500 words, or when a relative link in a shipped Markdown file reaches no file or no heading. The README is the landing page: put details on a page in `guide/` and link that page from the README.
