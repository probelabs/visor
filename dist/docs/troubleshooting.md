## 🛠️ Troubleshooting

- Increase logging with `--debug` or action `debug: true`.
- Validate config locally: `npx -y @probelabs/visor@latest --check all`.
- Ensure required permissions in Actions: contents/read, pull-requests/write, issues/write, checks/write.
- If annotations don’t appear, confirm schema is `code-review` and issues have file/line.
- For remote extends, set `--allowed-remote-patterns` or disable via `--no-remote-extends`.
