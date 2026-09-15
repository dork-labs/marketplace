---
name: writing-developer-guides
description: Structures developer guides for optimal AI agent and human consumption. Use when creating or updating a project's developer guides, or when documentation needs to support autonomous coding agents.
---

# Writing Developer Guides

## Overview

This skill teaches how to write developer guides that work well for both AI coding agents and human developers. The key insight: AI agents need fast context retrieval, clear decision support, and copy-paste ready patterns.

## When to Apply

- Creating a new developer guide
- Updating or refactoring an existing guide
- Reviewing guides for completeness
- User asks about documentation structure

## Core Principle

**Structure for retrieval, not teaching.**

Traditional documentation assumes sequential reading. AI agents retrieve specific information based on task context. Every section should be independently useful.

## Required Sections (In Order)

Each developer guide should include these sections in this sequence.

### 1. Title + Overview (2-3 sentences)

```markdown
# [Topic] Guide

## Overview

[What this guide covers] and [why it matters for this project].
```

**Why this order:** AI agents use the overview to determine relevance before reading further.

### 2. Key Files Table

```markdown
## Key Files

| Concept       | Location             |
| ------------- | -------------------- |
| Configuration | `src/path/config.ts` |
| Types         | `src/path/types.ts`  |
```

**Why early:** Agents need to know WHERE before HOW. This prevents searching.

### 3. Decision Matrix ("When to Use What")

```markdown
## When to Use What

| Scenario | Approach | Why       |
| -------- | -------- | --------- |
| Need X   | Use Y    | Because Z |
| Need A   | Use B    | Because C |
```

**Critical for AI:** A good decision matrix eliminates most clarifying questions. Agents can pattern-match their current task to the right approach.

### 4. Core Patterns (Code Examples)

Give each pattern a 1-2 sentence context, then a complete example:

```typescript
// Complete, runnable example
// Comments explain WHY, not WHAT
export function example() {
  // This pattern ensures X because Y
  return result;
}
```

**Requirements:**

- Examples must be complete (copy-paste ready)
- Include imports if non-obvious
- Comments explain reasoning, not mechanics

### 5. Anti-Patterns

Show the wrong way and the right way together:

```typescript
// ❌ NEVER do this
badPattern(); // Causes X problem

// ✅ Do this instead
goodPattern(); // Prevents X, ensures Y
```

**Why essential:** AI agents learn from negative examples. Without anti-patterns, agents may generate common mistakes that "look right" but violate project conventions.

### 6. Step-by-Step Procedures (Optional)

Include when there are procedural tasks (adding X, configuring Y). Each step names the file or command, shows the code, and ends with a way to verify it worked:

1. **Create the file**: `path/to/file.ts`
2. **Register it**: add it to `config.ts`
3. **Verify**: run the test or build command and check for the expected output

**Key:** Each step should have verification. Agents need to confirm success before proceeding.

### 7. Troubleshooting (Optional but Recommended)

```markdown
## Troubleshooting

### "Error message verbatim"

**Cause**: Why this happens
**Fix**: What to do

### [Symptom description]

**Cause**: Why this happens
**Fix**: What to do
```

**Why this format:** AI agents can grep for error messages and find solutions directly.

## Writing Guidelines

### For AI Agent Consumption

| Do                              | Don't                            |
| ------------------------------- | -------------------------------- |
| Use tables for structured data  | Use prose for comparisons        |
| Put decision criteria in tables | Bury decisions in paragraphs     |
| Make code examples complete     | Show fragments requiring context |
| Use consistent section headers  | Vary section names across guides |
| Include file paths in examples  | Assume agents know locations     |

### For Human Readability

| Do                              | Don't                                   |
| ------------------------------- | --------------------------------------- |
| Keep overview under 3 sentences | Write lengthy introductions             |
| Use bullet points for lists     | Use numbered lists unless order matters |
| Link to related guides          | Duplicate content from other guides     |
| Explain "why" in comments       | Over-document obvious code              |

## Quality Checklist

Before completing a guide, verify:

- [ ] Overview explains what AND why in 2-3 sentences
- [ ] Key Files table maps concepts to locations
- [ ] Decision matrix covers common scenarios
- [ ] All code examples are complete and runnable
- [ ] Anti-patterns section exists with ❌/✅ format
- [ ] Troubleshooting covers common errors (if applicable)
- [ ] Section order matches this skill's template
- [ ] No duplicated content from other guides (link instead)

## References

For the complete section-by-section template with detailed examples, see `reference.md` in this skill directory.

## Adapt for your repo

- **Where guides live.** Name the folder (for example `contributing/` or `docs/dev/`) so the skill triggers on the right files.
- **The index.** If you keep an index of guides, say what each entry needs (the guide, the file patterns and keywords it covers, when it was last checked) and that every new or changed guide updates it.
- **Your languages.** Swap the TypeScript examples for your stack's, and add your code block language tags to the table in `reference.md`.
- **User-facing docs are different.** Guides here are for developers and agents. Pages a non-developer reads follow `writing-for-humans` instead.
