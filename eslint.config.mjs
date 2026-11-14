import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  files: ["src/**/*.ts"],
  rules: {
    "no-eval": "error",
    "no-implied-eval": "error",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.property.name='get'][arguments.0.value='baseUrl']",
        message:
          "Read the server URL through resolveConnection: a workspace must not be able to set it.",
      },
    ],
  },
});
