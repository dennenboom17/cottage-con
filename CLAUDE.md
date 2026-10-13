# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cottage Con — a Mistwind/steampunk-themed board game weekend companion app (games, potluck, itinerary, chores, expense splitting, push notifications). React + Vite frontend, Firebase (Auth + Firestore + Cloud Messaging) backend, deployed as a static site to Firebase Hosting. Single group event, real-time synced via Firestore listeners — no server code in this repo (no Cloud Functions source, no custom backend).

## Commands

```bash
npm install        # install deps
npm run dev         # start Vite dev server at http://localhost:5173
npm run build        # production build to dist/
npm run preview       # preview the production build locally
npm run deploy        # build + firebase deploy --only hosting (deploys to https://cottagecon-b8d82.web.app)
npx eslint .          # lint (no npm script defined for this; eslint.config.js is present)
```

There is no test suite/framework configured in this repo.

`firebase login` is required once before the first deploy.

## Architecture

**Nearly the entire app lives in one file: [src/App.jsx](src/App.jsx) (~5000 lines).** It contains Firebase initialization, all data hooks, all reusable UI primitives, and every view/screen component, in that order top-to-bottom. When looking for something, grep this file rather than expecting a directory of components — `src/` otherwise only has `main.jsx` (entry point) and `index.css` (global styles/animations).

### Data flow
- Firebase app/auth/Firestore/messaging are initialized at module scope in App.jsx with hardcoded config values (this is a client-only static site — there's no env-var/secret separation; Firestore security rules are the actual access boundary, not the client code).
- The root `App()` component owns all state (auth user, profile, and one `useState` per Firestore collection: `users`, `games`, `food`, `supplies`, `voyageMenu`, `deckHands`, `receipts`, `itinerary`, `costSettings`) and subscribes to each collection with `onSnapshot` for live sync.
- All state and action callbacks (`doSaveGame`, `doDelFood`, `doClaimSlot`, etc.) are bundled into a single `ctx` object and passed down as a single `ctx` prop to every screen/view component — there's no React Context provider or prop-drilling of individual fields. When adding a new piece of state or action, add it to the `ctx={...}` assembly in `App()` and it becomes available everywhere via `ctx.whatever`.
- Firestore writes go through two tiny helpers, `fsSet(collection, id, data)` (merge-set) and `fsDel(collection, id)` — most `do*` actions in `App()` are one-line wrappers around these.

### Views/navigation
- Navigation is not URL-routed — it's a `view` string in state (`setView("dashboard")`, etc.), switched in `Shell()`'s `<main>` via `{view==="x" && <X ctx={ctx}/>}`. Tab metadata lives in the `TABS` array (~App.jsx:1485).
- `EngineRoom` is the admin panel (itinerary editor, deck-hand slot editor, deposits, crew ranks, notifications, cost calculator), gated behind a hardcoded client-side passcode check (not real security — Firestore rules are what actually protect data).

### AI features (Gemini)
- "Ask the Gemini oracle" chat/game-recommender (`CrewAssistant`, `GameRecommender`) and vision-based box-photo/receipt scanning call the Gemini REST API directly from the client (`GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_URL` near the top of App.jsx) rather than going through the Firebase AI SDK — this was a deliberate choice to avoid requiring Firebase App Check (see comment at App.jsx:15).
- The Gemini key is **not** in source: `GEMINI_API_KEY` is read from `import.meta.env.VITE_GEMINI_API_KEY`, set in git-ignored `.env.local` (template: `.env.example`). Never hard-code or commit it. Vite inlines `VITE_*` values into the built bundle, so the key is still visible to site visitors — it must be restricted by HTTP referrer + API in Google Cloud Console. Vitest doesn't load `.env.local`; `vite.config.js` supplies a dummy key for tests.
- **BGG game IDs come from an index, not from Gemini.** `src/bggIndex.js` (pure, no React/Firebase — the one deliberate exception to "everything is in App.jsx") parses BoardGameGeek's `boardgames_ranks.csv` data dump into a name→ID index of games with 500+ ratings (~7,000 titles, ~300 KB) and does exact/fuzzy name matching. The index lives in a single Firestore doc, `bggIndex/current` (games stored as one JSON string), published by an admin from **Engine Room → BGG Index** (the CSV is parsed in the browser; it never touches the repo). `lookupBGG(name, known?)` in App.jsx loads it once per page (`getBggMatcher`) and returns `source: "index"` (exact match → real `boardgamegeek.com/boardgame/<id>` link, with name/year/rating from BGG; Gemini only fills players/weight/blurb), `"search"` (index loaded but no exact match → BGG search link + `candidates` shown as "did you mean" buttons; the model's remembered ID is deliberately ignored), or `"gemini"` (no index published/readable → legacy behaviour). Needs a Firestore security rule allowing signed-in users to read/write `bggIndex`. The dump is licensed data: `boardgames_ranks*` and `bgg-index*` are git-ignored — never commit the CSV/zip or a generated index. Refresh by re-publishing a newer dump.
- Tests live in `src/test/` (`npm test`; Vitest + Testing Library, Firebase fully mocked in `src/test/setup.js`). Set `BGG_RANKS_CSV` to a downloaded dump to also run the real-data index test.

### Narrative roles (secret-role game layer)
- `NARRATIVE_FACTIONS` / `NARRATIVE_ROLES` (App.jsx, exported) define the roles. An admin assigns one per player in **Engine Room → Narrative Roles** (`NarrativeManager`, stored as `users/{uid}.narrativeRole` via `doAssignNarrativeRole`); each player sees only their own briefing in a sealed card at the top of the **Personal Log** (`NarrativeDossier`, rendered by `CaptainsLog`; tap to unlock). A role with `requires: "<roleKey>"` (the buyers/hunters that chase the arms dealer or smuggler) is only handed out together with that role by `pickRandomRoles`, and `NarrativeManager` warns when a hand-assigned role has no target; `requires` must not chain. The unlocked dossier also holds a private "Crew Suspect Board" (`RoleGuessBoard`) where a player records guesses about everyone else's role; those guesses live in `localStorage` (`cc-role-guesses:<uid>`), deliberately not Firestore, because every signed-in user can read every Firestore user doc. The board's "Check my guesses" button is enabled only once every other crew member has a guess ("Not playing (no role)" is a valid guess, so the board doesn't reveal who has a role), scores via `scoreGuesses` against the current `users[*].narrativeRole`, and shows only a count (never which guesses were right). Each check is appended to `cc-role-checks:<uid>` in `localStorage`; its length is the "Checks made" number.
- The chat assistant's closing game-answer line is no longer hardcoded in `GEMINI_SYSTEM`: each question, `pickChatTip` draws at random from the standing joke (`HUSS_TIP`) plus the `tips` of the *asker's own* role, and `buildAllContext` passes it to the model in a `CLOSING TIP` section (the system prompt falls back to the Huss line if that section is absent, e.g. for `GameRecommender`). Keep it to the asker's own role: tips from other roles would leak who holds what.
- It's honor-system only: every signed-in user can read every `users` doc, so roles are not truly hidden. `NarrativeDossier` reads the live `users[uid]` doc rather than `profile` because `profile` is loaded once at sign-in and would miss a role assigned later. `Card` ignores `onClick`, so attach click handlers to a wrapper element.

### Push notifications
- `usePushNotifications` hook (App.jsx) requests FCM permission/token and stores it on the user's profile.
- `public/sw.js` and `public/firebase-messaging-sw.js` are the service workers; `vite.config.js` has a custom `copySwFiles` plugin to ensure both are copied into `dist/` on build (Vite doesn't do this automatically for `public/` files referenced only by the SW registration, and `firebase.json` sets no-cache headers on them specifically).
- Sending a notification writes a doc to the `notifications` Firestore collection for fan-out; there's no Cloud Functions source in this repo, so server-side delivery logic (if any) lives outside this codebase.

### Styling
- No CSS framework/component library. All styling is inline `style={}` objects using a shared theme object `T` (colors) defined near the top of App.jsx, plus a `CREW_RANKS`/`GAME_CAT_COLORS` lookup for badge colors. `index.css` only holds global resets, `@font-face`/animation keyframes, and a few utility classes (`.cc-desktop-tabs`, `.cc-hamburger`, `.cc-fade`) used for responsive show/hide and page-transition effects.
- Icons are Tabler Icons (`<i className="ti ti-*">`, loaded via CDN in `index.html`).

### Firebase project
- Project alias/id: `cottagecon-b8d82` (`.firebaserc`). Hosting config (`firebase.json`) serves `dist/`, rewrites everything to `index.html` (SPA), and sets special headers for the two service workers and `manifest.json`.
