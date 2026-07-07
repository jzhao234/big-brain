# Seed interview prompt

Paste the prompt below into each LLM you use regularly (ChatGPT, Claude, Gemini, …) — ideally in the account where you have the most history, with memory/personalization enabled. Each model knows different things about you; run it in all of them and drop every output into your vault's `inbox/` folder (one file per model, e.g. `inbox/seed-chatgpt.md`). Then triage with the `process-inbox` prompt.

---

```text
You are helping me seed my "second brain" — a personal knowledge base in
markdown that my AI assistants will read to understand me and my work. Export
everything you know or can infer about me from our conversation history and
your memory of me. This is for my own private notes, so be direct, specific,
and complete — no flattery, no hedging, no generic filler that could describe
anyone.

Output rules:
- Plain markdown, structured EXACTLY with the section headers below.
- Concrete facts and specifics (names, tools, dates, numbers) over vague
  summaries. "Uses FastAPI and Playwright on a Vultr VPS" is useful;
  "interested in web development" is not.
- If you genuinely know nothing for a section, write "No data" — do not invent.
- Where you are inferring rather than recalling, prefix the line with
  "(inferred)".
- Include things I mentioned only once if they seem durable (projects, people,
  constraints, preferences). Skip one-off trivia.

# Seed export — [your model name] — [today's date]

## Profile
Who I am: name, role, company/industry, location/timezone, languages.

## Current projects
Every distinct project or initiative I've discussed, one bullet each:
what it is, its goal, current status/blockers, key technologies. Include
side projects and personal ones.

## Expertise & stack
What I'm skilled at, my usual tools/languages/frameworks/platforms, my
development environment and workflow. Note skill level where you can tell.

## How I like to work with AI
My communication preferences: response length and format, tone, how much
explanation I want, pet peeves, standing instructions I've given you,
corrections I've made to you more than once.

## Goals & priorities
Near-term and long-term goals I've expressed — career, projects, learning,
personal. What I seem to be optimizing for.

## People & organizations
People, teams, companies, and clients I've mentioned, with their relationship
to me and any relevant context.

## Recurring tasks & routines
Things I do repeatedly: reviews, reports, deploys, meetings, habits I've
mentioned or tried to build.

## Decisions & constraints
Standing decisions, rules, or constraints I operate under (budget, security
policies, tech choices already made, things I've said I never want to do).

## Open loops
Unfinished threads from our conversations: questions I never resolved,
things I said I'd do, ideas I parked.

## Blind spots
Based on everything above: what do I repeatedly struggle with, forget, or
avoid? What would a good assistant proactively watch for? Be honest.
```

---

## After you run it

1. Save each model's output to `inbox/seed-<model>.md` in your vault.
2. Ask your vault-connected assistant to run the `process-inbox` prompt: it will merge duplicates across models, turn projects into project notes, people into `people/` notes, preferences into a note your agent instructions can point at, and open loops into tasks.
3. Re-run this interview every few months — models accumulate new context about you.
