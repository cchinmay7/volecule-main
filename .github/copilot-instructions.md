# Copilot Instructions for CI Reliability

## GitHub Actions + pnpm

- Only call `pnpm` in workflows after `pnpm/action-setup@v4` has run.
- Use `pnpm/action-setup@v4` before `actions/setup-node` when using pnpm in CI.
- In `actions/setup-node`, use `cache: 'pnpm'` only after pnpm is installed by `pnpm/action-setup`.
- Preferred workflow pattern:
  1. `actions/checkout`
  2. `pnpm/action-setup@v4` (`run_install: false`)
  3. `actions/setup-node` (`cache: 'pnpm'`)
  4. `pnpm install --frozen-lockfile`
  5. `pnpm run <script>`

## Package manager version source of truth

- Keep `package.json` `packageManager` as the single source of truth.
- Avoid adding a second pnpm version declaration in workflow config.
