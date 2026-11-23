import { noteRepos, sameRepo, summaryHeading } from "./context.js";
import { isGitRepo, lineChangeTimes, uncommittedFiles } from "./git.js";
import { projectStatus } from "./projects.js";
import type { DoctorFinding, Heading, Note } from "./types.js";
import { fencedLines, nameKey, todayISO } from "./util.js";
import { sameRank, type Vault } from "./vault.js";

/** Lint the vault: broken links, duplicate names, stale projects, overdue tasks, hygiene. */
export function runDoctor(vault: Vault): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const notes = vault.notes(true);
  const active = notes.filter((n) => !n.archived);
  const activePaths = new Set(active.map((n) => n.path));

  // Resolve links once and build inbound edges in one pass. Backlinks-per-note
  // repeatedly scans the vault and becomes cubic when name resolution is linear.
  const incoming = new Set<string>();
  const ambiguous = new Set<string>();
  for (const note of notes) {
    for (const link of note.links) {
      const target = vault.resolveLink(link);
      if (target) {
        if (target.path !== note.path) incoming.add(target.path);
        // Title and alias ties are reported once below as duplicate-name; a
        // tie between bare filename stems (two `fleet.md` in different
        // folders) is only visible from the link that hits it.
        const candidates = vault.nameCandidates(link.target);
        const best = candidates[0];
        const tied = best ? candidates.filter((c) => sameRank(c, best)) : [];
        const key = `${note.path}\0${nameKey(link.target)}`;
        if (
          activePaths.has(note.path) &&
          best?.by === "stem" &&
          tied.length > 1 &&
          !ambiguous.has(key)
        ) {
          ambiguous.add(key);
          findings.push({
            severity: "warning",
            rule: "ambiguous-link",
            message: `[[${link.target}]] matches the filename of ${tied.length} notes (${tied.map((c) => c.note.path).join(", ")}) and resolves to ${best.note.path}; link by path or give the intended note that title or alias`,
            path: note.path,
          });
        }
      } else if (activePaths.has(note.path) && !isAttachmentTarget(link.target)) {
        findings.push({
          severity: "warning",
          rule: "broken-link",
          message: `[[${link.target}]] does not resolve to any note`,
          path: note.path,
        });
      }
    }
  }

  // Frontmatter that didn't parse: its metadata reads as empty, and rewrites
  // that would re-serialize it refuse until the YAML is fixed.
  for (const note of active) {
    if (note.frontmatterError !== undefined) {
      findings.push({
        severity: "warning",
        rule: "bad-frontmatter",
        message: `Frontmatter doesn't parse (${note.frontmatterError}); its metadata is ignored until the YAML is fixed`,
        path: note.path,
      });
    }
  }

  // Duplicate titles/aliases (ambiguous wikilink targets).
  const byName = new Map<string, string[]>();
  for (const note of active) {
    const names = [note.title, ...note.aliases];
    for (const name of names) {
      const key = nameKey(name);
      byName.set(key, [...(byName.get(key) ?? []), note.path]);
    }
  }
  for (const [name, paths] of byName) {
    const unique = [...new Set(paths)];
    if (unique.length > 1) {
      findings.push({
        severity: "warning",
        rule: "duplicate-name",
        message: `"${name}" is the title/alias of ${unique.length} notes: ${unique.join(", ")}`,
      });
    }
  }

  // Repeated sibling headings (two "## Log" sections): append_note targets the
  // first, so the second never receives entries. Repeats under different
  // parents, such as the same sub-headings in every dated entry, are a normal
  // structure and are not flagged.
  for (const note of active) {
    const counts = new Map<string, { text: string; count: number }>();
    // Parents are identified by line, not text: two "## Log" sections are
    // different parents even though they share a name.
    const parents: Array<{ depth: number; line: number }> = [];
    for (const h of note.headings) {
      while (parents.length > 0 && parents[parents.length - 1]!.depth >= h.depth) parents.pop();
      const key = `${parents[parents.length - 1]?.line ?? -1}\0${nameKey(h.text)}`;
      const entry = counts.get(key) ?? { text: h.text, count: 0 };
      entry.count++;
      counts.set(key, entry);
      parents.push({ depth: h.depth, line: h.line });
    }
    for (const { text: h, count } of counts.values()) {
      if (count < 2) continue;
      findings.push({
        severity: "warning",
        rule: "duplicate-heading",
        message: `Heading "${h}" appears ${count} times in the same section; appends under it go to the first one, so merge or rename the others`,
        path: note.path,
      });
    }
  }

  // Uncommitted notes in an auto-commit vault: a commit that failed (e.g. a
  // held index.lock) or an edit made outside big-brain.
  if (vault.config.git.autoCommit) {
    const dirty = uncommittedFiles(vault.dir);
    if (dirty.length > 0) {
      findings.push({
        severity: "warning",
        rule: "uncommitted-changes",
        message: `${dirty.length} file${dirty.length === 1 ? " has" : "s have"} uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}); commit them, or check why an auto-commit failed`,
      });
    }
  }

  // One repository, one owning note: `big-brain context` loads the owner at
  // session start and refuses to guess between two. Entries overlap when
  // their paths match and they don't name two different hosts.
  const claims = active.flatMap((note) =>
    noteRepos(note, "repos").map((ref) => ({ ref, path: note.path })),
  );
  const reported = new Set<string>();
  for (const [i, claim] of claims.entries()) {
    const label = claim.ref.host ? `${claim.ref.host}/${claim.ref.path}` : claim.ref.path;
    if (reported.has(label)) continue;
    const holders = new Set([claim.path]);
    for (const other of claims.slice(i + 1)) {
      if (sameRepo(claim.ref, other.ref)) holders.add(other.path);
    }
    if (holders.size > 1) {
      reported.add(label);
      findings.push({
        severity: "warning",
        rule: "shared-repo",
        message: `${label} is listed under repos: by ${holders.size} notes (${[...holders].join(", ")}), so session context loads none of them; keep it in one note and use related_repos: in the others`,
      });
    }
  }

  // Stale active projects.
  const staleMs = vault.config.staleProjectDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const note of active.filter((n) => n.type === "project")) {
    if (projectStatus(note) === "active" && now - note.mtimeMs > staleMs) {
      const days = Math.floor((now - note.mtimeMs) / (24 * 60 * 60 * 1000));
      findings.push({
        severity: "info",
        rule: "stale-project",
        message: `Active project untouched for ${days} days — still active, or should it be paused/done?`,
        path: note.path,
      });
    }
  }

  // Overdue tasks.
  const today = todayISO();
  for (const note of active) {
    for (const t of note.tasks) {
      if (!t.done && !t.cancelled && t.due !== undefined && t.due < today) {
        findings.push({
          severity: "warning",
          rule: "overdue-task",
          message: `Overdue task (due ${t.due}): ${t.text}`,
          path: note.path,
        });
      }
    }
  }

  // Inbox pileup.
  const inboxCount = active.filter((n) =>
    n.path.startsWith(`${vault.config.folders.inbox}/`),
  ).length;
  if (inboxCount >= 10) {
    findings.push({
      severity: "info",
      rule: "inbox-pileup",
      message: `${inboxCount} unprocessed inbox notes — worth a triage pass`,
    });
  }

  // Notes with no frontmatter type and no links either way (likely dumped, never wired in).
  for (const note of active) {
    if (note.type === "daily" || note.type === "inbox") continue;
    if (!note.path.includes("/")) continue; // root-level meta files (BRAIN.md, CLAUDE.md)
    const hasOutgoing = note.links.length > 0;
    const hasIncoming = incoming.has(note.path);
    if (!hasOutgoing && !hasIncoming) {
      findings.push({
        severity: "info",
        rule: "orphan-note",
        message: "No links in or out — connect it to a project, area, or related note",
        path: note.path,
      });
    }
  }

  // Bloated notes: consolidation candidates (daily notes exempt: they're logs
  // and are allowed to grow).
  for (const note of active) {
    if (note.type === "daily") continue;
    const lines = note.body.split("\n").length;
    if (note.body.length > 8000 || lines > 250) {
      findings.push({
        severity: "info",
        rule: "bloated-note",
        message: `${Math.round(note.body.length / 1000)}KB / ${lines} lines; move old Log entries verbatim to an archive note, or split out a section that covers a separate topic`,
        path: note.path,
      });
    }
  }

  // Possible duplicates: two active notes sharing most of their text.
  findings.push(...possibleDuplicates(active));

  // Summaries behind their Log: session context shows a note's Summary (or
  // Overview, or Goal), so Log entries added on a later day than the Summary
  // last changed may have left it stale.
  if (isGitRepo(vault.dir)) {
    for (const note of active) {
      if (note.type === "daily") continue;
      const finding = staleSummary(vault.dir, note);
      if (finding) findings.push(finding);
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * Unresolved wikilinks with a file extension (`![[diagram.png]]`) point at
 * attachments, not notes. The extension must look like one (a letter then up
 * to 9 alphanumerics) so titles such as "Release 1.2" or "Meeting w. Bob" are
 * still checked as note links.
 */
function isAttachmentTarget(target: string): boolean {
  const basename = target.split(/[\\/]/).pop() ?? target;
  const extension = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(basename)?.[1]?.toLowerCase();
  return extension !== undefined && extension !== "md";
}

/** Words per shingle: long enough that notes sharing a template or a topic's vocabulary don't match. */
const SHINGLE_WORDS = 5;
const DUPLICATE_SIMILARITY = 0.5;
/** A shingle in more notes than this is boilerplate (a shared footer), not evidence of a copy. */
const COMMON_SHINGLE_NOTES = 50;

/**
 * Pairs of notes whose runs of consecutive words mostly coincide (Jaccard
 * similarity of their word shingles). Comparing word runs instead of word sets
 * keeps notes built from one template, or about one topic, apart while copied
 * passages still match. Candidate pairs come from an inverted index, then
 * each is scored on its full shingle sets. A shingle in more than
 * COMMON_SHINGLE_NOTES notes nominates no pairs, since it would pair every
 * note with every other at quadratic cost; two notes made almost entirely of
 * such boilerplate are therefore not compared.
 */
function possibleDuplicates(active: Note[]): DoctorFinding[] {
  const docs = active
    .filter((n) => n.type !== "daily" && n.body.length > 200)
    .map((n) => ({ path: n.path, shingles: bodyShingles(n.body) }))
    .filter((d) => d.shingles.size > 0);
  const postings = new Map<string, number[]>();
  docs.forEach((doc, i) => {
    for (const s of doc.shingles) {
      const list = postings.get(s);
      if (list) list.push(i);
      else postings.set(s, [i]);
    }
  });
  const candidates = new Set<number>();
  for (const list of postings.values()) {
    if (list.length > COMMON_SHINGLE_NOTES) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) candidates.add(list[a]! * docs.length + list[b]!);
    }
  }
  const findings: Array<DoctorFinding & { key: number }> = [];
  for (const key of candidates) {
    const a = docs[Math.floor(key / docs.length)]!;
    const b = docs[key % docs.length]!;
    const [small, large] =
      a.shingles.size <= b.shingles.size ? [a.shingles, b.shingles] : [b.shingles, a.shingles];
    // Jaccard can't reach the threshold when one set is under that share of the other.
    if (small.size < large.size * DUPLICATE_SIMILARITY) continue;
    let inter = 0;
    for (const s of small) if (large.has(s)) inter++;
    const sim = inter / (a.shingles.size + b.shingles.size - inter);
    if (sim >= DUPLICATE_SIMILARITY) {
      findings.push({
        key,
        severity: "info",
        rule: "possible-duplicate",
        message: `${Math.round(sim * 100)}% of the text overlaps with ${b.path}; merge them or make them distinct`,
        path: a.path,
      });
    }
  }
  return findings.sort((x, y) => x.key - y.key).map(({ key: _key, ...finding }) => finding);
}

/** Distinct runs of SHINGLE_WORDS consecutive words in a note body. */
function bodyShingles(body: string): Set<string> {
  const words = body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const shingles = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    shingles.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return shingles;
}

/** A list item: a bullet or a numbered item, indented at most three spaces. */
const LIST_ITEM_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const LIST_ITEM = new RegExp(`${LIST_ITEM_MARKER.source}\\S`);

/**
 * A finding when Log entries were added on a later day than the note's Summary
 * (or Overview, or Goal) last changed, dated line by line with `git blame`.
 * It compares the days lines were committed, not the dates written in Log
 * lines, which are whatever the writer typed. A fix that only deletes Summary
 * lines leaves no trace in blame, so the finding stays until a line changes.
 */
function staleSummary(vaultDir: string, note: Note): DoctorFinding | undefined {
  const summary = summaryHeading(note);
  const log = note.headings.find((h) => h.text.trim().toLowerCase() === "log");
  if (!summary || !log) return undefined;
  const lines = note.body.split("\n");
  // Every Summary line counts, as session context shows them all; Log entries
  // are list items outside code fences.
  const fenced = fencedLines(lines);
  const summaryLines = sectionRange(note, summary, lines.length).filter((i) => lines[i]!.trim());
  const entries = sectionRange(note, log, lines.length).filter(
    (i) => !fenced[i] && LIST_ITEM.test(lines[i]!),
  );
  if (summaryLines.length === 0 || entries.length === 0) return undefined;
  const times = lineChangeTimes(vaultDir, note.path);
  if (!times) return undefined;
  const at = (i: number): number | undefined => times[note.bodyLine + i];
  const summaryTimes = summaryLines.map(at);
  if (summaryTimes.some((t) => t === undefined)) return undefined;
  const changed = todayISO(new Date(Math.max(...(summaryTimes as number[]))));
  const newer = entries.filter((i) => {
    const t = at(i);
    return t !== undefined && todayISO(new Date(t)) > changed;
  });
  if (newer.length === 0) return undefined;
  // The most recently added entry; among entries added together, the last in the note.
  const latestLine = newer.reduce((a, b) => ((at(b) ?? 0) >= (at(a) ?? 0) ? b : a));
  const latest = lines[latestLine]!.replace(LIST_ITEM_MARKER, "").trim();
  const quoted = latest.length > 100 ? `${latest.slice(0, 99)}…` : latest;
  const count = newer.length === 1 ? "1 Log entry was" : `${newer.length} Log entries were`;
  return {
    severity: "info",
    rule: "stale-summary",
    message: `${summary.text.trim()} last changed ${changed}, and ${count} added after it (latest: "${quoted}"). Session context shows the ${summary.text.trim()}: update it, or refresh its as-of date if it still holds`,
    path: note.path,
  };
}

/** Body line indexes inside a heading's section, up to the next heading of the same or higher level. */
function sectionRange(note: Note, heading: Heading, lineCount: number): number[] {
  const next = note.headings.find((h) => h.line > heading.line && h.depth <= heading.depth);
  const end = next?.line ?? lineCount;
  return Array.from(
    { length: Math.max(0, end - heading.line - 1) },
    (_, k) => heading.line + 1 + k,
  );
}
