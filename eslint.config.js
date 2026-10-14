import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

// `skills/browser-tools` is vendored under its own MIT license, so it stays out
// of the lint; everything else in the tree is checked.
export default tseslint.config(
	{ ignores: ["node_modules/**", "skills/browser-tools/**"] },
	js.configs.recommended,
	tseslint.configs.recommended,
	{ languageOptions: { globals: globals.node } },
	prettier,
);
