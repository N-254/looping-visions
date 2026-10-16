<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- Dreamer is local-only: all items and media live in IndexedDB (src/lib/db.ts); no backend — the spec forbids accounts/cloud sync.
- All local audio goes through the single `engine` in src/lib/audio-engine.ts: memory-bounded files use a once-rendered overlapping crossfade buffer with native looping; long files use two streamed gain-routed voices. Output uses one MediaStream audio element for Media Session; this avoids periodic buffer scheduling and competing sessions.
- Player dismissal uses pointer gestures isolated from controls plus an accessible close control; unmount stops the local engine so interrupted dismissal cannot leave audio behind.
- YouTube sources use only the official IFrame player, kept visible in the player screen — never extract or proxy audio.
