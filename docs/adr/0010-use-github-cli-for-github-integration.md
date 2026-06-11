# Use GitHub CLI for GitHub integration

The Code Factory MVP uses GitHub CLI as its GitHub integration layer instead of calling GitHub APIs directly. This keeps authentication aligned with the user's GitHub account and lets the TypeScript CLI focus on orchestration; missing `gh` or other required external commands fail naturally through command execution rather than a custom preflight layer.
