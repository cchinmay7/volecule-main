# Copilot Instructions for CI Reliability

## GitHub Actions + pnpm

- Do **not** call `pnpm` directly in workflows.
- Use `corepack pnpm ...` for install and scripts.
- In `actions/setup-node`, do **not** set `cache: 'pnpm'` unless pnpm is explicitly installed first in a prior step.
- Preferred workflow pattern:
  1. `actions/checkout`
  2. `actions/setup-node` (no pnpm cache setting)
  3. `corepack enable`
  4. `corepack pnpm install --frozen-lockfile`
  5. `corepack pnpm <script>`

## Package manager version source of truth

- Keep `package.json` `packageManager` as the single source of truth.
- Avoid adding a second pnpm version declaration in workflow config.
