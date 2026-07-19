/**
 * Pre-commit gate (spec §9.6): format + lint on staged files, plus a
 * project-wide typecheck whenever any TypeScript changes (tsc is project-scoped,
 * so it cannot run per-file). CI re-runs the same gates unumgehbar.
 */
export default {
  '*.ts': ['eslint --fix', 'prettier --write'],
  '*.{js,mjs,cjs,json,jsonc,md,yml,yaml,html,css}': ['prettier --write'],
  '**/*.ts': () => 'pnpm -s typecheck',
};
