# Speech Coach

Speech Coach is a small app for your Mac that helps you improve your spoken English. It reads what
you dictate with [Wispr Flow](https://wisprflow.ai), finds your grammar, word-choice, filler-word
and pronunciation mistakes, and shows them on a private website on your own computer. Every
morning it also suggests 5 new words that fit your level.

> Speech Coach is a personal side project. It is not made by, or connected to, Wispr. It reads
> Wispr Flow's local database, which has no official public format, so a Wispr update can break it.

## What it does

Every day, two jobs run in the background:

1. **At 21:00, the night job runs.**
   1. It copies the day's dictations from Wispr Flow's local database. It only reads that
      database and never changes it.
   2. It sends the text to Claude, which finds grammar, word-choice and filler-word mistakes.
   3. It sends the recordings to Gemini, which gives notes on pronunciation.
   4. It saves the mistakes and writes a short lesson for each day.
2. **At 09:00, the morning job runs.** It asks Claude for 5 new words that fit your technical
   level and your recent mistakes, then shows a Mac notification.

A third background process keeps the website running at <http://127.0.0.1:4777>. It has five tabs:

| Tab | What you see |
|---|---|
| **Today** | The day's 5 new words, the lesson, and each mistake: what you said (struck through in red), the better version, and why. Under each mistake, "What Wispr heard" shows your exact words and plays your recording. |
| **Calendar** | One dot per day. A darker dot means more mistakes. Click a day to open it. |
| **Repeats** | The mistakes you make again and again, with how many days each one appeared. |
| **Search** | Find any word or phrase in everything you have dictated, or in the saved mistakes. |
| **Settings** | Apps to skip, which AI models to use, and the history of recent runs. |

If your Mac is asleep or off at 21:00 or 09:00, the job runs the next time you log in.

## Tech stack

- **Runtime:** [Bun](https://bun.sh) 1.4 or later, with TypeScript in strict mode.
- **Database:** SQLite, through Bun's built-in `bun:sqlite`. It uses FTS5 for search.
- **Website:** `Bun.serve`, with pages built as HTML text on the server. It has one CSS file and
  one small script for the audio player. There is no framework and no build step.
- **Text analysis and daily words:** the Claude API (`@anthropic-ai/sdk`). The default model is
  Claude Opus, and you can change it in Settings.
- **Pronunciation:** the Gemini API, which works on the free tier. The Claude API does not accept
  audio, so Gemini handles the recordings.
- **Scheduling:** macOS `launchd`, which runs the night job, the morning job and the website.
- **Tests:** `bun test`, with about 630 tests that use fake Claude, fake Gemini and a fake Wispr
  database. No test calls a paid API.

The only runtime dependency is the Anthropic SDK.

## What you need

- A Mac. The app uses `launchd`, `osascript` notifications and Wispr Flow's Mac database path.
- [Wispr Flow](https://wisprflow.ai) for desktop, signed in and used for dictation.
- [Bun](https://bun.sh) 1.4 or later.
- An **Anthropic API key**, from <https://console.anthropic.com>. This one is paid: every night's
  text analysis and every morning's words use your Anthropic credits.
- A **Gemini API key**, from <https://aistudio.google.com/apikey>. The free tier is enough.

## Set up Wispr Flow

Speech Coach reads Wispr Flow's local history, so Wispr Flow must keep that history on your Mac.

1. Open Wispr Flow and go to **Settings → Data & Privacy**.
2. Set **Data Storage** to keep history on this device. This is the default. If you choose
   "auto-delete after 24 hours" or "never store", Speech Coach gets little or no data.
3. You can leave Wispr's own privacy mode (no storage on Wispr's servers) either way. It does not
   change the local history.

Nothing else is needed. Speech Coach finds the database at:

```
~/Library/Application Support/Wispr Flow/flow.sqlite
```

Good to know:

- Wispr deletes its own local recordings after about 14 days. Speech Coach does not keep copies.
  So pronunciation notes and the play button only work for recent dictations, and text-only
  mistakes stay forever.
- Wispr does not have to be open when the jobs run. It only has to have recorded your dictations
  before then.

## Install

```sh
git clone <this repo> speech-coach
cd speech-coach
bun install
```

### Store your API keys

The keys live in one file outside the repo, so they can never be committed by mistake:

```sh
mkdir -p ~/.config/speech-coach
touch ~/.config/speech-coach/env
chmod 600 ~/.config/speech-coach/env
```

Open `~/.config/speech-coach/env` in an editor and add:

```sh
ANTHROPIC_API_KEY=your-anthropic-key
GEMINI_API_KEY=your-gemini-key
```

Do not paste keys into the terminal or into any file inside the repo.

### Check that it works

```sh
bun run check      # type check + all tests
bun run web        # start the website by hand, then open http://127.0.0.1:4777
```

### Start the background jobs

```sh
bun run setup:launchd
```

This writes three files to `~/Library/LaunchAgents/` and loads them:

| Agent | When it runs |
|---|---|
| `local.speech-coach.nightly` | 21:00, and at login if it missed a run |
| `local.speech-coach.morning` | 09:00, and at login if it missed a run |
| `local.speech-coach.web` | All the time, at <http://127.0.0.1:4777> |

The first night job reads all your past Wispr history, so it can take 20 to 30 minutes.

If you move the repo folder or reinstall Bun, run `bun run setup:launchd` again. The agent files
hold the full paths.

### Stop or remove it

```sh
for a in nightly morning web; do
  launchctl bootout gui/$(id -u)/local.speech-coach.$a
  rm ~/Library/LaunchAgents/local.speech-coach.$a.plist
done
```

To delete your coaching history as well, remove `~/.local/share/speech-coach/`.

## Where things are kept

| What | Where |
|---|---|
| API keys | `~/.config/speech-coach/env` |
| Your coaching data (dictation text, mistakes, lessons, words, settings, run history) | `~/.local/share/speech-coach/coach.sqlite` |
| Logs | `~/Library/Logs/speech-coach/` |
| Recordings | Not stored by Speech Coach. The website plays them straight from Wispr's database. |

To back up your history, copy `coach.sqlite`.

## How the repo is organised

```
speech-coach/
├── package.json        scripts: nightly, morning, web, setup:launchd, check
├── LICENSE             MIT
└── src/
    ├── cli/            entry points that launchd starts. They only connect the real parts.
    ├── jobs/           one night run and one morning run, plus the lock and the run history
    ├── pipeline/       the night steps: import, text analysis, audio analysis, lesson
    ├── clients/        the only code that calls Claude and Gemini
    ├── wispr/          the only code that opens Wispr's database, read-only
    ├── db/             Speech Coach's own database and settings
    ├── domain/         small pure rules: time zones, status values
    ├── audio/          turns WAV bytes into waveform peaks for the player
    ├── web/            the website: server, security checks, page layout, CSS, player script
    │   └── pages/      one file per tab
    ├── setup/          writes the launchd files
    └── testing/        fake Claude, fake Gemini and a fake Wispr database for tests
```

Coding rules the code follows:

- **Thin entry files.** `src/cli/` builds the real database, clients, logger and clock, and passes
  them to a function in `jobs/` or `web/`. Tests pass fakes instead.
- **Errors are values.** Functions that can fail return `Result` (`{ ok: true, value }` or
  `{ ok: false, error }`) instead of throwing.
- **One door to each outside system.** Only `src/wispr/source.ts` may open Wispr's database. A test
  scans the source and fails if any other file does, or if any code writes to Wispr.
- **Tests sit next to the code.** `today.ts` has `today.test.ts` beside it. Run them all with
  `bun run check`.

## Commands

| Command | What it does |
|---|---|
| `bun run check` | Type check and run all tests |
| `bun run web` | Start the website by hand |
| `bun run nightly` | Run the night job now (uses your API credits) |
| `bun run morning` | Run the morning job now (uses your API credits) |
| `bun run setup:launchd` | Install or refresh the background jobs |

## Known limits

- Mac only.
- Wispr Flow's database format is not public. A Wispr update can change it. The night job checks
  the columns it needs and stops with a clear error if they change.
- Wispr sometimes cleans up your words before saving them, so some grammar slips never reach
  Speech Coach.
- Gemini's pronunciation notes are hints, not a verdict. They are sometimes wrong.
- The free Gemini tier has a daily limit. When the limit is hit, older recordings wait for later
  nights, and Wispr may delete them first.

## License

[MIT](LICENSE)
