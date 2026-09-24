# Changelog

## 0.2.3

- README, setup check and configure skill: the key goes into the plugin option with `claude plugin install … --config typesafe_api_key=…`, read from the clipboard. The earlier hint `/plugin configure` is not a documented command and did not ask for the key.

## 0.2.2

- The setup check no longer reports a key in the plugin option as missing. Claude Code passes that option only to hooks, so the check now reports where the hook found the key on its last routed call.

## 0.2.1

- README: one section "TypeSafe and Jev" says what Jev is, why the plugin uses it, how to turn it on, what it sends, and what it costs. The cost per call is about $0.00005, measured on real briefs; the old figure of $0.0001 was too high.

## 0.2.0

Changes that need an action after the update:

- **Jev is opt-in.** A new setting `jevEnabled`, off by default. While it is off, the hook sends no brief to TypeSafe and changes no route. To keep routing, run `node scripts/orch-config.mjs set jevEnabled=true` or `/orchestrator:configure`.
- **The key comes only from the plugin option or `TYPESAFE_API_KEY`.** The file `~/.config/typesafe/.env` and the Keychain item `orchestrator-typesafe` are no longer read. Move the key into the plugin option; see the README section "TypeSafe and Jev". The variable `ORCH_TYPESAFE_ENV_FILE` is gone.

## 0.1.1

- README: a "Why" section, an "Install" section before the setup, and a correct statement of the one paid API (TypeSafe).

## 0.1.0

First public release.

- Routes each `Agent` call with Jev: a worker and a model for the plugin's own workers, a model for other agent types.
- Seven workers, two of them thin wrappers that run the Codex CLI on the ChatGPT plan. Codex is off by default.
- Limit rules for the 5-hour and weekly Claude windows, fed by the status line.
- A dispatch log, a report and an offline evaluation runner.
