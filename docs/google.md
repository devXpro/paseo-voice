# Google Cloud Text-to-Speech

Where the speech comes from, what it costs, and how the plugin keeps count.

## Getting a key

Google Cloud Console → **APIs & Services** → **Credentials** → **Create credentials** →
**API key**. Then restrict it, so a leaked key is worth nothing anywhere else:
**Restrict key** → **Cloud Text-to-Speech API**, and nothing beside it.

From a terminal instead:

```sh
gcloud services enable texttospeech.googleapis.com
gcloud services api-keys create --display-name="paseo-voice TTS" \
  --api-target=service=texttospeech.googleapis.com
```

Paste it into **Голос → Ключ Google** in the panel. The key is checked against Google
before it is kept, so a bad paste comes back as a message rather than as silence.

### Where the key lives, and what the panel shows

`~/.paseo-voice/google-key.txt`, mode `600`, outside the plugin directory — so
`paseo plugin remove` does not take it along.

The panel never receives the key. It is sent `AIzaSy…8Cc`: the first six characters and
the last three, which is enough to tell one key from another and useless to anybody
reading it off a screenshot. Replacing a key means typing the whole thing again; there
is no reveal button, because there is nothing on that side to reveal.

## Billing

Google requires a billing account on the project even to use the free allowance. The
allowance is **monthly and recurring** — it comes back on the first of every month, it
is not a one-off trial, and an unused remainder does not carry over.

Budget alerts do not cap spending, and the TTS quotas cannot be lowered to act as a
ceiling. The only real limit is the card, so attach a virtual one with a small balance.

## The three families

They are billed separately and have separate allowances, so running one dry leaves the
others untouched.

| Family | Free each month | Beyond that | |
|---|---|---|---|
| **Chirp 3 HD** | 1 000 000 chars | $30 / million | The newest generation, the most alive |
| **Standard** | 4 000 000 chars | $4 / million | Same audio as WaveNet, four times the allowance |
| **WaveNet** | 1 000 000 chars | $4 / million | Byte-identical to Standard — pick Standard |

Russian `ru-RU-Standard-A` and `ru-RU-Wavenet-A` return the same bytes. They are one
set of voices billed two ways, and only the allowance differs. There is no reason to
choose WaveNet.

## What that is in practice

A million characters is roughly **twenty hours** of speech. For an assistant reading
its answers aloud through a working day, the Standard allowance of four million is
hard to exhaust; Chirp 3 HD's single million is reachable in a heavy month.

## How the counting works

The plugin counts the characters it sends, per family, per month, in
`~/.paseo-voice/usage.json`. It does not ask Google. Google's own figure lives in Cloud
Monitoring and lags by minutes, and the number that matters while choosing a voice is
the one that is current.

**Лимиты** shows a bar per family: characters spent against the free allowance, and
what any overspend has cost at that family's price. The reset date is the first of
next month.

The count is of characters handed to Google, which is what Google bills — including
punctuation and spaces.

## When Google refuses

The reason appears under the key field rather than being swallowed. The usual ones:

- **403 with `SERVICE_DISABLED`** — the Text-to-Speech API is not enabled on that
  project.
- **403 with `API_KEY_SERVICE_BLOCKED`** — the key is restricted to other APIs. Add
  Cloud Text-to-Speech to its allowed list.
- **400 with `API key not valid`** — a truncated paste. Keys are `AIza` and 35 more
  characters, 39 in total.
- **Billing errors** — the project has no billing account. The free allowance still
  requires one.
