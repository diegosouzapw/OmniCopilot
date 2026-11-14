import tseslint from "typescript-eslint";

const SERVER_URL_MESSAGE =
  "Read the server URL through resolveConnection: a workspace must not be able to set it.";

/**
 * Calls of `<method>` whose first argument is "baseUrl" or ends in ".baseUrl"
 * ("omnicopilot.baseUrl"), as a string literal or a template literal without
 * substitutions; `cfg.get(...)` and `cfg["get"](...)` alike.
 */
function serverUrlReads(method) {
  const callee = [`[callee.property.name=${method}]`, `[callee.property.value=${method}]`];
  const argument = [
    "[arguments.0.value=/(^|\\.)baseUrl$/]",
    "[arguments.0.type='TemplateLiteral'][arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked=/(^|\\.)baseUrl$/]",
  ];
  return callee.flatMap((c) =>
    argument.map((a) => ({ selector: `CallExpression${c}${a}`, message: SERVER_URL_MESSAGE }))
  );
}

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-syntax": ["error", ...serverUrlReads("/^(get|inspect)$/")],
    },
  },
  {
    // The connection module is the one place that reads the setting, through inspect().
    files: ["src/connection.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...serverUrlReads("/^get$/")],
    },
  }
);
