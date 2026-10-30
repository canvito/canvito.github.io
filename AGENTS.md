# Instructions for AI agents

This repository is Canvito's personal journal of learning and teaching (GitHub Pages at canvito.github.io).
Sealed entries and the keyring live in the PRIVATE repo `canvito/canvito-vault`, cloned at `../canvito-vault`.
**Always go through the CLI** (`node tools/canvito.mjs`). Never hand-edit files in `data/` or `media/`: sealed content is encrypted and the indexes must stay consistent.

## Before you start

* Keys must already be cached. Check with `node tools/canvito.mjs list`; it fails with "Locked" if they aren't. If locked, ask the owner to run `node tools/canvito.mjs login`. Never ask for, store, or log the passphrase.
* Run `node tools/canvito.mjs help` for every command.

## Creating or updating an entry

Write a Markdown file with front matter (anywhere, e.g. a temp folder), then `put` it:

```markdown
---
title: First time teaching fractions
date: 2009-09-14          # YYYY | YYYY-MM | YYYY-MM-DD | YYYY-MM-DDTHH:mm — backdating is expected
kind: teach               # learn | teach | reflect | milestone | artifact | page
tier: protected           # public | protected (access-code readers) | private (owner only)
tags: [teaching, math]
summary: One-sentence dek shown under the title and on cards.
cover: ./board.jpg        # local path (auto-uploaded), https URL, or media:<id>
location: Seattle, WA
---
Body in Markdown. ![Caption](./photo.jpg) uploads local files automatically
(encrypted when the tier is protected/private).

@[Recording](https://youtu.be/VIDEO_ID)   ← embeds YouTube/Vimeo/Loom/Google Docs/Drive, mp4/mp3, links

> [!LESSON] Takeaway
> Explaining is learning twice.
```

```powershell
node tools/canvito.mjs put path\to\entry.md      # creates; writes the new id back into the file
node tools/canvito.mjs put path\to\entry.md      # run again after edits (id present) to update
node tools/canvito.mjs show <id> --out entry.md  # export an existing entry for editing (attachments are kept)
```

Other commands: `new`, `edit <id> --field value`, `delete <id>`, `list [--q] [--tag] [--kind] [--tier] [--json]`, `doctor`.

## Rules

1. **Default tier:** when the owner hasn't said, ask. If you can't ask, use `private`. Never make something public unless explicitly told to: git history makes public content permanent.
2. **Commit messages must never contain titles or details of protected/private entries.** Use `journal: update` (or a public title only for public entries).
3. After changes: `node tools/canvito.mjs doctor`, then `node tools/canvito.mjs publish` (commits & pushes both repos). Never `git add` vault files to this public repo.
4. Large videos (> ~25 MB) belong on YouTube/Vimeo (unlisted) and should be embedded with `@[caption](url)`.
5. Unsupported attachment types (SVG, HTML, executables) are rejected on purpose.
6. Access codes: `node tools/canvito.mjs codes new --type once|timed|permanent --label "Who" [--hours N]`. Show the code to the owner only; never commit it or write it to files.
7. Run `npm test` after changing any code under `assets/js`, `tools`, or `worker`.
8. Never print, log or commit secrets: the passphrase, GitHub tokens, Worker secrets, or the cached key file in `~/.canvito`. After changing `worker/`, redeploy with `cd worker; npx wrangler deploy` (only when the owner asks).
9. Deployment details (Worker URL, KV, Turnstile, tokens) are listed under "Current deployment" in README.md. Keep that table accurate if you change infrastructure.
