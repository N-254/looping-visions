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
- All local audio goes through the single `engine` in src/lib/audio-engine.ts (scheduled Web Audio crossfades, routed to an <audio> element for Media Session/background); never create other players.
- YouTube sources use only the official IFrame player, kept visible in the player screen — never extract or proxy audio.
