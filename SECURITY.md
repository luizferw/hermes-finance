# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include secrets,
financial records, tokens, or database dumps in a report. Use GitHub's private
vulnerability reporting feature from the repository's **Security** tab. If it
has not been enabled yet, contact the repository owner privately before sharing
details.

Include the affected version or commit, deployment context, reproduction steps,
impact, and a minimal proof of concept with all sensitive values redacted.

## Scope and deployment assumptions

Kosh is self-hosted. Operators control the server, PostgreSQL database, backups,
reverse proxy, and secrets. Direct database access is a trusted administrative
boundary and can bypass application-level ownership checks.

Before exposing an instance, use a unique `BETTER_AUTH_SECRET`, an HTTPS
`APP_URL`, a distinct `KOSH_ENCRYPTION_KEY`, and a strong PostgreSQL password.
Back up the encryption key separately from database archives. Losing it makes
encrypted values unrecoverable.

AI and MCP are opt-in. When enabled, Ask Kosh may send the question, relevant
conversation context, and selected tool results to Google Gemini. External MCP
access is read-only but still expands the deployment's attack surface.

Kosh does not claim a compliance certification, end-to-end encryption, or a
security guarantee. Only the latest published release is expected to receive
security fixes.
