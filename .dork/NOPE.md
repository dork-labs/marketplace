# Safety Boundaries

## Never Do

- Never push to main/master without explicit approval
- Never delete production data or databases
- Never commit secrets, API keys, or credentials
- Never run destructive commands (rm -rf, DROP TABLE) without confirmation
- Never modify CI/CD pipelines without review

## Always Do

- Always create a new branch for changes
- Always run tests before committing
- Always preserve existing functionality when refactoring