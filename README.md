# Git (Obsidian plugin)

Source control for the vault, modelled on VS Code's SCM view. Desktop only; uses the system `git`.

- **No repo?** On startup the plugin offers to run `git init` and create a `.gitignore` (the whole `.obsidian/` app-data folder, `.trash/`, OS noise — the vault tracks note content only). Also: command *Git: Initialize repository*.
- **Source control** (ribbon icon / left sidebar): branch + ahead/behind, Fetch / Pull / Push (offers *Publish branch* when there is no upstream), commit message box (`Ctrl+Enter`), Commit menu (amend, & push, stage all, undo last commit). Groups *Merge changes* / *Staged changes* / *Changes* with hover actions: open, stage, unstage, discard. Click a file for a unified diff.
- **Remotes**: `Git: Manage remotes` or the server icon: list with URLs, add, change URL, remove. Push with no remote opens this dialog.
- **Branches**: click the branch name or the status bar item. *Merge branch into current* (merge icon / command) picks any local or remote branch; conflicts land in *Merge changes*. Local / remote / current badges; picking a remote branch creates a tracking local one; *Create new branch…* on top.
- **Commit graph**: `Git: Open commit graph` or the graph icon. Lanes, merges, ref labels (HEAD / local / remote / tag), author, relative date. Click a commit for full message and changed files. *Load more* for older history.
- **Conflicts**: pull/merge conflicts appear under *Merge changes*; click a file to open the resolver with *Accept current / incoming / both* per block (and *Accept all*), then *Mark as resolved*. *Abort merge* is in the banner.

Settings: git executable, extra PATH entries (macOS Homebrew), author name/email override.

## Dev
```
npm install
npm run build      # -> main.js
npm test           # bundle load check + conflict parser + graph lanes + git wrapper on a temp repo
npm run dev        # watch
```
Enable in Obsidian: Settings → Community plugins → Git (reload plugin after a rebuild).
