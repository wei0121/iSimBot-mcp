# Contribute

[Back to README](../README.md)

Bug reports and focused pull requests are welcome. For bugs, include your macOS,
Xcode, and iSimBot-MCP versions, reproduction steps, and relevant error output.
Remove private data from logs and screenshots.

## Local development

Requires Node.js 20.9+ and npm:

```bash
npm ci
npm test
```

`npm test` builds TypeScript and runs the test suite. Simulator testing also needs
Xcode and the runtime dependencies; see [local installation](installation.md#local-installation).

Keep changes focused, add tests where appropriate, and update usage documentation
when changing tool behavior. Discuss larger changes in an issue first.
