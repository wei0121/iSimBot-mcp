# Releases

The workflow uses GitHub Actions' built-in `GITHUB_TOKEN` for this repository.
No personal token or additional secret is required.

## Publish

1. Create a source branch named exactly `release/vX.Y.Z`, for example `release/v1.0.5`.
2. Update `package.json`, both root version fields in `package-lock.json`, and add
   a non-empty `## X.Y.Z` entry to `CHANGELOG.md`.
3. Open a PR from that branch to `main` in this repository, review and merge it.
4. The Release workflow tests the merged commit, creates its tag, and publishes
   the archive, checksum and Homebrew formula.
5. Download the published `isimbot-mcp.rb` asset and copy it to
   `homebrew-tap/Formula/isimbot-mcp.rb`. Submit and merge a tap PR using your
   existing GitHub Desktop or SSH access. Homebrew users can then upgrade.

PR titles do not control publishing. Normal PRs, unmerged closures and fork PRs
cannot publish. Tag pushes no longer trigger this workflow. The tag points to
that PR's exact merge commit, not whatever main contains when the job runs.
The workflow does not write to the tap repository.

Merge this workflow change before merging the first release PR. Repository rules
must permit the workflow to create version tags; existing tags are never moved.

## Retry

Use **Actions → Release → Re-run jobs** on the original run. Existing tags must
point to the same merge commit. Interrupted draft uploads can be replaced;
published Releases are downloaded and verified, never overwritten.
