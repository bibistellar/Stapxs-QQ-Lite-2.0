# AI Maintenance Instructions

## Scope

Make focused changes for the maintainer-approved GitHub Issue. Preserve unrelated behavior and
existing user changes. Never modify automation workflows, credentials, release authorization, or
deployment permissions as part of an automated Issue implementation.

## Project validation

- Install dependencies with `yarn install --immutable`.
- Run `yarn typecheck` for TypeScript and Vue changes.
- Run `yarn test:connection` and `yarn test:outgoing` when related behavior may be affected.
- Use `yarn lint` only when prepared to inspect and retain its formatting changes because it runs
  ESLint with `--fix`.
- Do not build or publish releases from an Issue implementation job.

## Safety

- Do not read, modify, print, or summarize `.env`, authentication files, signing material, or
  GitHub Actions secrets.
- Do not use network access, Git commands, GitHub commands, or files outside the provided workspace.
- Do not modify `AGENTS.md` or files under `.github/workflows/`.
