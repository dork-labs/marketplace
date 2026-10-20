# Roadmap

A read-only board of your team's roadmap, in a tab beside a room. It shows what needs a decision, what's Now, Next and Later, and who changed what and why.

It reads one file, `roadmap/roadmap.json`, from a GitHub repo you choose. People and agents change the roadmap by editing that file. Each change is a commit, and the commit's first line is the reason the board shows. Nothing on the board changes the file.

## Before you install

- **It needs a GitHub token.** You make a fine-grained token that can only read one repo, and paste it into the extension's settings. It stays on this computer and is only sent to api.github.com.
- **Its server code runs in its own process.** That process may connect to api.github.com and nothing else. It can't read your other files or DorkOS's data.
- **It shows nowhere until you pick a room.** See step 4 below.

## Set it up

1. **Make a token.** On GitHub, go to Settings → Developer settings → Fine-grained tokens → Generate new token.
   - Resource owner: the account or organisation that owns the repo.
   - Expiration: 90 days.
   - Repository access: **Only select repositories**, and pick only the repo that holds `roadmap/roadmap.json`.
   - Repository permissions: **Contents: Read-only**. GitHub adds **Metadata: Read-only** by itself. Leave everything else at No access.
2. **Paste it in.** In DorkOS, open Settings → Extensions, find **Roadmap**, and paste the token into **GitHub token**.
3. **Name the repo.** In the same place, set **Repo** to `owner/name`.
4. **Pick the room.** Still on the Roadmap card, use **Roadmap tab shows** to choose the room the tab belongs in. Until you do, the tab doesn't show anywhere.

Three optional settings:

- **Who decides** puts a name on the decisions lane ("Needs Sam"). Empty means "Needs you".
- **Who keeps the roadmap** is the handle that **Ask in this room** mentions, without the @.
- **Repo for PR numbers** is where a pull request link written as a bare number (`"ref": "42"`) opens, as `owner/name`. Empty shows bare numbers as text.

## What you see

- **Needs you**: every open ask in the file, the one due soonest first. Each one links to where it gets answered: its thread, or the approval card on Home. The board has no approve or deny buttons, and an ask taken off the file is never treated as a yes.
- **Since you last looked**: each change since you pressed **Mark seen**, with who made it and why. A change with no reason says "No reason given". Before your first Mark seen, it shows the five newest changes.
- **Now, Next, Later**: the bets in file order. Click one to see why it matters, its fields and links, and its last few changes. Later starts folded.
- **A change while you're looking** waits behind a pill, such as "@sam moved 2 cards · Show". Nothing moves until you press Show.
- **Ask in this room** (on a card's ⋯ menu) copies a message asking for a move and puts your cursor in the room's message box. Finish it and send it yourself.

## When something goes wrong

The board never goes blank. It keeps the last good version on screen, dimmed, under one line that says what happened:

- The file doesn't parse: which line, whose change broke it, and a link to the file.
- GitHub can't be reached: when the copy on screen is from, and a Retry button.
- The token has expired, or stopped working: the date, and who can reconnect it.

In the week before the token expires, a quiet line under the title says so.

## The file

`roadmap/roadmap.json` holds `version: 1`, up to six `milestones` (`id`, `title`, `date`), and `items`. Each item is one bet: `id` (a ULID), `kind: "project"`, `title`, `horizon` (`now`, `next` or `later`), `moscow` (`must`, `should`, `could` or `wont`), `owner` (a handle), `status`, `why`, and optionally `target`, `links` and `needs`. An item that breaks these rules is skipped and listed by id, and the rest of the board still shows. Shipped and dropped bets stay in the file but leave the board.

## For contributors

```bash
npm install
npm test            # parser, GitHub client, service, server and panel
npm run typecheck
npm run format:check
```

The tests use made-up roadmaps only. Never copy a real roadmap into this repo.
