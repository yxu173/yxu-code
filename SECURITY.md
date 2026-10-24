# Security policy

yxu runs coding agents on your machine. Subagents work in git worktrees under `.yxu/`, but
they run with the permissions you configure (`permission:` per agent). An agent with `yolo`
permission can run any command your user can.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub security advisories](https://github.com/yxu173/yxu-code/security/advisories/new).
Include the version (`yxu --version`), your platform, and steps to reproduce. You should get a
reply within a week.

In scope: anything that lets a repository, config file, agent output or model response make yxu
do something the user did not configure. Examples are writing outside the worktree, applying
without `yxu apply`, or leaking credentials.

## Supported versions

Only the latest release receives fixes until 1.0.
