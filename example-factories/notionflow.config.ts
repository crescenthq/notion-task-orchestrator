import { defineConfig } from "notionflow";

export default defineConfig({
  factories: [
    "./factories/intent.ts",
    "./factories/magic-8.ts",
    "./factories/would-you-rather.ts",
    "./factories/shared-helper-demo.ts",
  ],
});
