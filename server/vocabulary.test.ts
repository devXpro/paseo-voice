import assert from "node:assert/strict";
import { test } from "node:test";
import { termsOf } from "./vocabulary.server.ts";

test("in Russian, jargon is the Latin words and the long Cyrillic ones that are not ordinary speech", () => {
  const terms = termsOf("Слушай, задеплой докер на staging, потом проверь постгрес", "ru");
  for (const word of ["staging", "задеплой", "докер", "постгрес"]) {
    assert.ok(terms.includes(word), word);
  }
  // Ordinary speech, which the recogniser already knows perfectly.
  assert.ok(!terms.includes("слушай"));
  assert.ok(!terms.includes("потом"));
});

test("in English, only what looks like a name or a piece of code counts", () => {
  const terms = termsOf("Can you restart the Postgres container and check the api_gateway logs on node2", "en");
  assert.deepEqual(terms.sort(), ["Postgres", "api_gateway", "node2"]);
});

test("a capital at the start of a sentence is grammar, not a name", () => {
  const terms = termsOf("Restart it. Then check the logs! Maybe ask Kubernetes why.", "en");
  assert.deepEqual(terms, ["Kubernetes"]);
});

test("in German every noun is capitalised, so only code-shaped words count", () => {
  const terms = termsOf("Kannst du den Container neu starten und die api_gateway Logs mit kubectl prüfen", "de");
  assert.deepEqual(terms, ["api_gateway"]);
});

test("in Ukrainian the Latin words are the jargon, and Cyrillic is left alone without a list of ordinary words", () => {
  const terms = termsOf("Задеплой, будь ласка, сервіс на staging і перевір логи через kubectl", "uk");
  assert.deepEqual(terms.sort(), ["kubectl", "staging"]);
});

test("accented names survive whole in Spanish, French and Portuguese", () => {
  assert.deepEqual(termsOf("Reinicia el contenedor de Postgres en Málaga", "es").sort(), ["Málaga", "Postgres"]);
  assert.deepEqual(termsOf("Redémarre le service sur Kubernetes et vérifie Grafana", "fr").sort(), ["Grafana", "Kubernetes"]);
  assert.deepEqual(termsOf("Reinicie o serviço no Supabase e veja os logs em São Paulo", "pt").sort(), ["Paulo", "Supabase", "São"]);
});

test("version numbers and dotted names are kept whole", () => {
  assert.deepEqual(termsOf("upgrade to v0.11.2 of paseo.sh today", "en").sort(), ["paseo.sh", "v0.11.2"]);
});
