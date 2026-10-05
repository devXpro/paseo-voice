import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The words somebody actually says, mined from their own transcripts.
 *
 * Whisper leans on a vocabulary hint when a sound could be two different words, and
 * that is most of what goes wrong with jargon: `постгрес` comes back as `прогресс`,
 * `докер` as `доктор`. A generic word list does not help, because the problem is
 * specific — it is this person's stack, this person's project names.
 *
 * So the list is taken from what they have already typed. Their own messages only:
 * an assistant's replies are full of words nobody pronounces out loud, and feeding
 * those in biases the recogniser towards prose it will never hear.
 */

/** Where Claude keeps per-project transcripts, under whichever config root is in use. */
const ROOTS = [
  path.join(homedir(), ".claude", "projects"),
  path.join(homedir(), "projects", "jobby-jobs", ".claude-data", "projects"),
];

/** Bounded so a long history does not turn a button press into a minute of reading. */
const MAX_FILES = 60;
const MAX_BYTES = 2_000_000;

/**
 * Words that survive: latin identifiers, and Cyrillic words of four letters or more.
 * Shorter Cyrillic is almost all grammar, and grammar is what Whisper is already good at.
 */
const WORD = /[A-Za-z][A-Za-z0-9._-]{2,}|[А-Яа-яЁё]{4,}/g;

/**
 * Ordinary speech, dropped.
 *
 * Frequency alone picks the wrong words: the commonest things anybody says are `если`,
 * `только`, `почему`, and the recogniser already knows those perfectly. What it needs
 * is the opposite — the rare word it keeps turning into a common one. So the frequent
 * ordinary words are removed and what remains is, by construction, this person's own
 * jargon.
 *
 * The English half is scaffolding rather than speech: transcripts carry markers like
 * `[Request interrupted by user]`, and those words were the top of the first list.
 */
const ORDINARY = new Set(
  (
    "который которая которые которое когда потом тогда чтобы чтоб нужно надо можно " +
    "давай давайте сейчас сделай сделать делать делаешь работает работать работа " +
    "просто очень такой такая такие вообще короче значит понял поняла понятно " +
    "смотри слушай спасибо пожалуйста хорошо ладно может можешь можем могу быть " +
    "есть было будет будем этот эта это того тому себя тебя меня всё все ещё еще " +
    "там тут как что где или его её них нам если только какой какая какие какое " +
    "через анекдот допустим должно должен должна нормально хочу хочешь тоже ничего " +
    "после этого прямо подожди погоди либо нельзя вроде давно опять снова сразу " +
    "теперь здесь туда сюда потому почему зачем откуда куда пока пусть типа вот " +
    "ну да нет не на по за из от до об при над под про без для над раз два три " +
    "мне тебе нему ней них нас вас они оно она он мы вы ты я так уже даже тоже " +
    "один одна одно одни больше меньше лучше хуже много мало очень самый самая " +
    "каждый любой другой другая другие новый новая старый первый второй последний " +
    "время момент место сторона вопрос ответ проблема решение случай пример " +
    "сказал сказать говорит говорить скажи покажи посмотри смотрю вижу знаю " +
    "думаю кажется получается выходит значить короч блин ага угу окей"
  ).split(/\s+/).concat(
    "the and for not was this that with you are have has will can could would should " +
    "from they them their there here what when where which who why how all any both " +
    "each few more most other some such only own same than too very just user tool " +
    "use request interrupted message original spoken instruction input output status " +
    "summary task notification completed system reminder content type role assistant"
      .split(/\s+/),
  ),
);

export type Term = { word: string; count: number };

/** One transcript line, as Claude writes them. Only our own messages are wanted. */
type Line = { type?: string; message?: { role?: string; content?: unknown } };

/**
 * What was actually said, out of a message that may be wrapped in scaffolding.
 *
 * Dictated turns arrive inside a `<spoken-input>` block, and that block is the best
 * possible source: it is literally this person speaking, which is what the recogniser
 * is about to hear again. Everything around it — instructions to the model, system
 * reminders, pasted output — is text nobody pronounces, and counting it produced a
 * word list of `instruction`, `Respond` and `chat.` on the first run.
 */
function spokenOnly(text: string): string {
  const said = [...text.matchAll(/<spoken-input>([\s\S]*?)<\/spoken-input>/g)].map((m) => m[1] ?? "");
  if (said.length > 0) {
    return said.join(" ");
  }
  // Nothing else counts. A typed message carries the same names, but it also carries
  // every harness marker — `[Request interrupted by user]`, image dimensions, "your
  // previous response had no visible output" — and those words topped the first two
  // attempts at this list. Spoken turns alone cost a little vocabulary and remove the
  // whole class of noise.
  return "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

/** Newest first: how somebody speaks this month beats how they spoke in the spring. */
async function transcripts(): Promise<string[]> {
  const found: { file: string; at: number }[] = [];
  for (const root of ROOTS) {
    let projects: string[];
    try {
      projects = await readdir(root);
    } catch {
      continue;
    }
    for (const project of projects) {
      let files: string[];
      try {
        files = await readdir(path.join(root, project));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }
        const full = path.join(root, project, file);
        try {
          found.push({ file: full, at: (await stat(full)).mtimeMs });
        } catch {
          // Gone between the listing and the stat. Not worth a complaint.
        }
      }
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, MAX_FILES).map((one) => one.file);
}

/**
 * The vocabulary worth handing to the recogniser, most frequent first.
 *
 * `minCount` keeps one-off typos out. The result is a plain list of words rather than
 * a sentence, which is what Whisper's prompt is for — it is read as context, not as
 * something to transcribe.
 */
export async function mine(limit = 60, minCount = 3): Promise<Term[]> {
  const counts = new Map<string, number>();
  for (const file of await transcripts()) {
    let body: string;
    try {
      const info = await stat(file);
      const handle = await readFile(file, "utf8");
      // Only the tail of a huge transcript: recent speech, and bounded work.
      body = info.size > MAX_BYTES ? handle.slice(-MAX_BYTES) : handle;
    } catch {
      continue;
    }
    for (const raw of body.split("\n")) {
      if (!raw.includes('"user"')) {
        continue;
      }
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        // A truncated last line, or the tail cut mid-record. Expected.
        continue;
      }
      if (line.message?.role !== "user") {
        continue;
      }
      const text = spokenOnly(textOf(line.message.content));
      // Tool results and pasted output arrive as user messages too, and they are full
      // of words nobody says. A spoken sentence is short.
      if (!text || text.length > 600) {
        continue;
      }
      for (const match of text.matchAll(WORD)) {
        const word = match[0];
        const key = /[А-Яа-яЁё]/.test(word) ? word.toLowerCase() : word;
        // Matched without case: the stop list is lower case and `Request` is not.
        if (ORDINARY.has(key.toLowerCase())) {
          continue;
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

/** The hint as the engine wants it: words, comma separated, nothing else. */
export const asPrompt = (terms: Term[]): string => terms.map((one) => one.word).join(", ");
