# Use committed krutrimbox project configuration

krutrimbox uses `.krutrimbox/config.json` as the repository-owned Project Configuration file, with configurable Template Slots pointing to Markdown files under `.krutrimbox/`. The directory is committed so teams can review and share krutrimbox policy, while generated runtime state stays local under ignored `.krutrimbox/logs/` and `.krutrimbox/locks/`.

Built-in prompts and templates are stored as Markdown files shipped with the CLI package instead of escaped TypeScript string constants. User configuration may partially override templates by friendly Template Slot names, but prompts remain built-in for now so krutrimbox keeps ownership of Sandboxed Agent safety boundaries. krutrimbox injects Factory Comment Markers outside user templates and fails fast on unsupported or invalid project configuration.
