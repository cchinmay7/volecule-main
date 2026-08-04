# Copilot Instructions for CI Reliability

## GitHub Actions + pnpm

- Do not rely on `actions/setup-node` to resolve pnpm automatically.
- Use `actions/setup-node` with `cache: 'npm'` for this repository.
- Install pnpm explicitly in CI using the version from `package.json` `packageManager`.
- Preferred workflow pattern:
  1. `actions/checkout`
  2. `actions/setup-node` (`cache: 'npm'`)
  3. `npm install -g pnpm@<version from packageManager>`
  4. `pnpm install --frozen-lockfile`
  5. `pnpm run <script>`

## Package manager version source of truth

- Keep `package.json` `packageManager` as the single source of truth.
- Avoid adding a second pnpm version declaration in workflow config.
