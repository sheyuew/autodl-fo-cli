# Operating AutoDL

For AutoDL login, account selection, instances, images, stock, AutoPanel files, or task results, read [docs/codex.md](docs/codex.md) first. Use `bash ./fo` subcommands with `--json`; login and foreground `panel watch` use a terminal instead. `bash ./fo --help` is the current command reference. Default execution is local and requires no server or invitation.

1. Check `doctor --json` and select the user's account. Resolve ambiguous instance names, paths, or destinations before submitting a change.
2. On `LOGIN_REQUIRED` or a closed local session, ask the user to run `bash ./fo login` in their own local terminal and return when done. For AutoPanel authentication, provide `bash ./fo panel login HANDLE`. Passwords stay in hidden terminal prompts; never request them in chat or pass secrets through arguments, environment variables, JSON, files, or Git.
3. Read and preview freely within the request. For a mutation, show the actual object, parameters, quote if present, and consequences; obtain the user's final `yes/no` before execute. Treat a new plan or changed quote as a new confirmation. Never generate `yes` on the user's behalf.
4. Inspect returned state or task results before reporting completion. An accepted request is not a finished transfer or a running instance. After an uncertain submission, query state before considering a retry.

Sessions are isolated per account and kept only in local process memory. Use the selected account consistently across preview, execution, and follow-up. The user's computer/network must stay online for commands and alerts; accepted AutoPanel cloud transfers continue independently. Keep legacy `remote` configuration separate from the default local workflow.
