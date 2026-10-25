# Security Policy

## Reporting a vulnerability

Report security issues through GitHub's private vulnerability reporting for
`ABD-Enterprises/zendesk-mcp`. Do not open a public issue for suspected
credential exposure, authentication bypasses, or vulnerabilities that could
modify or disclose Zendesk data.

Include the affected version, reproduction steps, impact, and any suggested
mitigation. ABD Enterprises will acknowledge a report after triage and will
coordinate disclosure when a fix is available.

## Credential handling

- Zendesk API-token and password authentication are not supported.
- OAuth client secrets must come from the process environment.
- Authorization-code tokens are stored outside the repository with owner-only
  file permissions.
- Tool output must never include access tokens, refresh tokens, or client
  secrets.
- Production deployments should use a dedicated OAuth client and the minimum
  scopes required by the enabled tools.

If credentials may have been exposed, revoke them in Zendesk immediately and
complete the authorization flow again.
