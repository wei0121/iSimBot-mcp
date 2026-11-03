# Contribute

[Back to README](../README.md)

Bug reports and focused pull requests are welcome. For bugs, include your macOS,
Xcode, and iSimBot-MCP versions, reproduction steps, and relevant error output.
Remove private data from logs and screenshots.

## Local development

On a supported Mac, install the project-private environment and test:

```bash
./scripts/local-setup.sh
./scripts/local-npm test
```

No global Node/Python or Brew installation is needed. See
[local installation](installation.md#local-installation) for MCP registration.
If you already have Node.js 20.9+ and npm, `npm ci && npm test` also runs the
build and unit tests; simulator operations require the additional runtimes.

Keep changes focused, add tests where appropriate, and update usage documentation
when changing tool behavior. Discuss larger changes in an issue first.

## Release

Update both package versions and the changelog, commit, then push a matching
`vX.Y.Z` tag. GitHub Actions tests the project and publishes the installation
archive, `SHA256SUMS`, and generated `isimbot-mcp.rb` in a Release.
Copy that published formula into `homebrew-tap/Formula/` and push the tap only
after the release succeeds. Its checksum must match the published archive.
