# Contributing

Contributions to Zendesk MCP are welcome.

## Development setup

```sh
cd plugins/zendesk-connector
npm ci
npm run check
```

Use Node.js 20 or newer. Tests must not depend on a live Zendesk account or
contain real customer data or credentials.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for authentication, HTTP, or tool-contract changes.
- Preserve OAuth-only authentication; do not add API-token or password flows.
- Treat MCP tool annotations as hints, not authorization controls.
- Document new environment variables and tool permissions.
- Run `npm run check` and `npm pack --dry-run` before opening a pull request.

Use issues for feature proposals that materially expand ticket access or add
new Zendesk resources so permissions and OAuth scopes can be reviewed first.
