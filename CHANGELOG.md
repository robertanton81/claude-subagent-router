# Changelog

## 0.1.0

First public release.

- Routes each `Agent` call with Jev: a worker and a model for the plugin's own workers, a model for other agent types.
- Seven workers, two of them thin wrappers that run the Codex CLI on the ChatGPT plan. Codex is off by default.
- Limit rules for the 5-hour and weekly Claude windows, fed by the status line.
- A dispatch log, a report and an offline evaluation runner.
