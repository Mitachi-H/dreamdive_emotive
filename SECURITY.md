# Security Policy (Public Repo Guidelines)

This repository is public. Follow these rules strictly:

- Never commit secrets: client IDs, client secrets, access tokens, license keys, or raw EEG/biometric data.
- Use environment variables only. Keep real values in `server/.env` and out of version control.
- Treat `wss://localhost:6868` (Cortex) as a self-signed-dev endpoint. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` outside local development.
- Avoid posting sensitive data in issues/PRs/logs. Redact when necessary.
- Rotate credentials if exposure is suspected.
- Consider enabling secret scanning in your hosting platform and CI.

If you find a security issue, avoid public disclosure in issues. Report privately to the maintainers.
