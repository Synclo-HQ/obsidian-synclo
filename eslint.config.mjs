import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["node_modules/", "main.js", "coverage/"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.mts"],
        },
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { enforceCamelCaseLower: true, brands: ["Synclo", "PowerPoint", "Obsidian", "Dataview", "Excalidraw", "Tasks", "Bases"], acronyms: ["PDF", "GIF", "SVG", "PNG", "JPEG", "URL"] }],
    },
  },
  {
    // Build scripts run in Node, never inside Obsidian.
    files: ["esbuild.config.mjs", "version-bump.mjs", "vitest.config.mts"],
    languageOptions: { globals: { process: "readonly" } },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "import/no-extraneous-dependencies": "off",
    },
  },
  {
    // Tests run in Node with vitest; they hold the plugin's pure modules to account.
    files: ["tests/**/*.ts"],
    languageOptions: { globals: { process: "readonly", __dirname: "readonly" } },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-window-timers": "off",
      "import/no-extraneous-dependencies": "off",
      "obsidianmd/ui/sentence-case": "off",
    },
  },
]);
