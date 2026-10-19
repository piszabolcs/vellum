# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [1.0.0] - 2026-10-19

### Added
- First public portfolio release.
- Streaming chat with a local Ollama model: thinking block, token statistics, context meter, smaller-context fallback, idle timeout and Retry.
- Floating bubble with a chat panel and a desktop window with the conversation archive; tray, global hotkey, hardware monitor, English and Hungarian UI.
- SQLite conversation archive with FTS5 search, rename, archive, fork, Markdown export and generated titles.
- Semantic recall over earlier conversations with `bge-m3` embeddings in `sqlite-vec` and hybrid search.
- Typed, approval-based memory (facts, people, projects, preferences, style rules) with priorities.
- Tool layer for small models: web search with sources, date, calculator, memory, read-only files, artifacts and skills, with a router, zod validation, call limits and a duplicate-call cache.
- Agent Skills in the `SKILL.md` format, three bundled skills and a template for new ones.
- Models window: installed models, a curated catalog, downloads with progress and a "will it run?" estimate.
- Security measures: SSRF-safe downloader, untrusted text framed as data, strict Content-Security-Policy, validated IPC.
- Vitest unit tests, Electron and Playwright smoke tests, demo profile seeding and a GitHub Actions workflow.
