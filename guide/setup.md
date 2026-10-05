# Setup

Part of the [Subagent Router documentation](../README.md#documentation).

If you still have the old `orchestrator@llm-orchestrator`, follow the steps under 0.3.0 in [CHANGELOG.md](../CHANGELOG.md) first.

Do the steps in this order. Each optional step adds one feature.

If you installed from the marketplace, use the skills in a session: `/subagent-router:configure`, `/subagent-router:setup` and `/subagent-router:report`. The `node scripts/...` commands in these pages do the same work, but they run from a clone of this repository: `git clone https://github.com/robertanton81/claude-subagent-router`.

## Turn on Jev

1. Create a key in the TypeSafe console: https://console.typesafe.ai/keys.
2. Store the key in the plugin option. A plugin option is a setting that Claude Code keeps for the plugin and passes only to the plugin's hooks. A hook is a script that Claude Code runs at a fixed event, for example before each subagent call. Copy the key, then run this in a terminal, in the project folder:

   ```bash
   k=$(pbpaste) && claude plugin install subagent-router@claude-subagent-router --scope local --config "typesafe_api_key=$k"; unset k; pbcopy </dev/null
   ```

   - Use the same `--scope` as your install. For an install in every project, leave out `--scope local`.
   - `pbpaste` reads the key from the clipboard. So the key is never typed, printed or kept in the shell history. `pbcopy </dev/null` clears the clipboard. On Linux, use `xclip -o -selection clipboard` or `wl-paste` instead of `pbpaste`.
   - The command also works when the plugin is already installed. It keeps the install and sets the option.
   - Claude Code keeps a sensitive option in the macOS Keychain, or in `~/.claude/.credentials.json` on other systems. The Claude Code docs say that Claude Code can also ask for the option when you enable the plugin. That path was not tested here.
   - The variable `TYPESAFE_API_KEY` works too, for example for scripts, CI, the evaluation runner, or on Windows. Set it in the environment that starts Claude Code.
   - No other place is read: no key file in your home folder, and never a `.env` file in a project. A cloned repository could ship its own key there and then receive your briefs in its own TypeSafe account.
3. Run `/subagent-router:configure` in a session and turn Jev on. Or run `node scripts/orch-config.mjs set jevEnabled=true`. A key alone does not turn Jev on. For one session, `ORCH_JEV_ENABLED=1` or `0` overrides the settings file.
4. Start a new session and ask for a task that uses a subagent, for example: "Use a subagent to list the files that import the module `fs`." Then run `/subagent-router:setup`. Its row "TypeSafe key" should say that the hook found the key in the plugin option.

## Turn on Codex (optional)

Codex stays off until you turn it on.

1. Install the Codex CLI and run `codex login` with your ChatGPT account.
2. Turn Codex on with `/subagent-router:configure`, or with `node scripts/orch-config.mjs set codexEnabled=true`. For one session, start Claude Code with `ORCH_CODEX_ENABLED=1`. The variable wins over the settings file, so `ORCH_CODEX_ENABLED=0` turns Codex off for one session.
3. Optional: the plugin has two Codex workers, small subagents that start Codex; see [The workers](routing.md#the-workers). Each one calls `scripts/orch-codex.mjs` with Bash: `run` once, then `wait` up to 6 times while the job still runs. To avoid a permission question each time, allow the script in your settings: `Bash(node */scripts/orch-codex.mjs *)`. The first `*` matches any folder, so this also allows a script with the same name in any other clone.

## Add the status line log (optional)

The limit rules move work to Codex, or cap models at Sonnet, when Claude is near its limit. The status line is the line at the bottom of Claude Code that a script of yours prints. Only that script receives your Claude usage numbers.

- Paste the lines from [scripts/statusline-snippet.sh](../scripts/statusline-snippet.sh) into your status line script, after the place where it reads `rate_limits`.
- The lines read the variables `RATE_5H`, `RATE_7D`, `RATE_5H_RESET`, `RATE_7D_RESET` and `SESSION_ID`. `RATE_5H` and `RATE_7D` are the percentages used in the 5-hour window and in the weekly (7-day) window. Set the ones your script has. The others are written as null.
- The limit rules need at least one of the two percentages. A window without a percentage never counts. The pace rule also needs the reset times. The snippet saves the session id too, but the limit rules do not use it.
- The lines write one sample, one reading of your usage, to `~/.claude/orchestrator/limits-latest.json`: the status line log. Without this file, the limit rules are off. Everything else works.
- A sample is too old after `limitsMaxAgeMs`, 10 minutes by default. When the sample is too old or cannot be read, the limit rules are off too. While Jev is on in `enforce` mode, the session start then says so once per session.
- The Claude Code desktop app runs no status line. All sessions on the machine read the same sample file. So in the desktop app, the limit rules act only while a terminal session on the same machine writes fresh samples.
- The setup check says when the file comes from an older snippet without the reset times.

## Check the setup

Run `/subagent-router:setup` in a session, or `node scripts/setup-check.mjs` from a clone. The check never prints a secret. The script names the next step for some items that are not OK, and the skill adds a next step for each of them.

Claude Code passes the plugin option only to hooks, so the check cannot see the key itself. Its row "TypeSafe key" reports where the routing hook found the key on its last routed call. `--live` also sends one test request to TypeSafe, but only when the key is in `TYPESAFE_API_KEY` and Jev is on.
