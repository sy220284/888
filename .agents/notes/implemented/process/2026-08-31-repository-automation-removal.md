# Agent Note: Repository automation is opt-in

Status: implemented

English | [中文](2026-08-31-repository-automation-removal.zh.md)

## Problem

Repository-owned GitHub Actions, Git hooks, and issue-policy checks automatically ran validation or blocked repository operations. This automation added maintenance cost and prevented an owner from choosing when checks should run.

## Decision

The repository contains no GitHub Actions workflow definitions, Lefthook configuration or installer, or issue-policy automation. Dependency installation does not modify Git configuration, and commit, merge, and push operations invoke no project-owned checks.

Build, test, lint, documentation, dependency, and packaging commands remain available through `package.json` for explicit local use. The obsolete `check:ci:*` entries and Windows gate harness are removed; the remaining local groups use `scripts/run-checks.ts`. GitHub repository rulesets are empty, and the default branch has no protection or required status checks.

## Alternatives considered

**Keep pull-request checks as advisory signals.** Any workflow trigger still consumes hosted execution and can become an operational dependency, so the repository owns no workflow definitions.

**Keep fast local hooks only.** Hooks still intercept commit, merge, or push operations and persist as machine-local state after checkout changes, so installation no longer configures them.

**Disable workflows without deleting their files.** Disabled definitions preserve stale automation and invite accidental reactivation; complete removal leaves the repository state explicit.

## Consequences

GitHub and local Git operations receive no automated validation from this repository. Contributors and release operators decide which manual commands to run, and unvalidated changes can reach the default branch.

Existing clones may retain hooks or Git configuration installed by an older revision because those files live outside the tracked worktree. Their owners must remove that machine-local state separately.
