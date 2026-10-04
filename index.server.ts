import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  applyPatch,
  applyToPaseo,
  disableSpeech,
  enableSpeech,
  fetchCue,
  getStatus,
  installBinary as installBinaryRpc,
  preview,
  refreshCloud,
  restartProxy,
  revertPatch,
  setActiveModel,
  setCloudVoice,
  setLocalVoice,
  previewCue,
  setCue,
  setCueVolume,
  setKey,
  setPhoneSafe,
  setPrompt,
  setProvider,
  setRate,
  setSteady,
} from "./shared/voice.shared.ts";
import { installBinary } from "./server/binary.server.ts";
import { createController } from "./server/controller.server.ts";
import { createEngine } from "./server/engine.server.ts";
import { render as renderCue, warmUp as warmUpCue } from "./server/cue.server.ts";
import { speak as speakWithGoogle } from "./server/google.server.ts";
import { createProxy } from "./server/proxy.server.ts";
import { durationSeconds, trimPadding, wavOf } from "./server/pcm.server.ts";
import { DEFAULTS, type Stored } from "./server/state.server.ts";

const log = (line: string) => console.log(line);

/** Two fixed ports: the proxy Paseo talks to, and the local engine behind it. Only the
 *  first ends up in anybody's config, but keeping them adjacent makes a clash obvious. */
const PROXY_PORT = DEFAULTS.port;
const ENGINE_PORT = DEFAULTS.port + 1;

export default function contribute(server: PluginServerContext) {
  const engine = createEngine({ port: ENGINE_PORT, log });
  // `proxy` is created below and read lazily, so the controller can report its state
  // without the two having to know about each other at construction time.
  const controller = createController({
    engine,
    log,
    proxy: () => ({ ...proxy.state(), port: PROXY_PORT }),
  });

  // `contribute` has to stay synchronous, so the proxy is built against a snapshot of
  // the choice that is refreshed on every status call and every mutation.
  let current: Stored & { googleKey: string } = { ...DEFAULTS, googleKey: "" };
  const refreshChoice = () =>
    void controller
      .choice()
      .then((next) => {
        current = next;
        // Fetched here rather than when the sound is wanted: by then it is too late,
        // and the first pause of a session would be the one with no music in it.
        return warmUpCue(next.cue, log);
      })
      .catch((failure: unknown) => log(`voice: could not read the choice: ${String(failure)}`));
  refreshChoice();

  const proxy = createProxy({
    port: PROXY_PORT,
    engine,
    choice: () => ({
      provider: current.provider,
      voice: current.provider === "google" ? current.googleVoice : current.voice,
      model: current.activeModel,
      language: current.language,
      rate: current.rate,
      cue: current.cue,
      cueVolume: current.cueVolume,
      steady: current.steady,
      phoneSafe: current.phoneSafe,
      googleKey: current.googleKey,
      pronunciations: [],
    }),
    log,
  });

  // Brought up with the plugin rather than on first use: its port is written into
  // `~/.paseo/config.json` and the daemon connects whenever it likes.
  void proxy.start().catch((failure: unknown) => log(`voice: proxy failed to start: ${String(failure)}`));

  /** Every mutation answers with the whole status; the proxy's view is refreshed with it. */
  const fresh = <T>(status: T): T => {
    refreshChoice();
    return status;
  };

  server.handle(getStatus, async () => fresh(await controller.status()));
  server.handle(setProvider, async (input) => fresh(await controller.setProvider(input.provider)));
  server.handle(setCloudVoice, async (input) => fresh(await controller.setCloudVoice(input.voice)));
  server.handle(setLocalVoice, async (input) => fresh(await controller.setLocalVoice(input.voice)));
  server.handle(setActiveModel, async (input) => fresh(await controller.setActiveModel(input.id)));
  server.handle(setRate, async (input) => fresh(await controller.setRate(input.rate)));
  server.handle(setCueVolume, async (input) => fresh(await controller.setCueVolume(input.volume)));
  server.handle(setCue, async (input) => fresh(await controller.setCue(input.cue)));
  server.handle(setPhoneSafe, async (input) => fresh(await controller.setPhoneSafe(input.phoneSafe)));
  server.handle(setSteady, async (input) => fresh(await controller.setSteady(input.steady)));
  server.handle(setKey, async (input) => fresh(await controller.setKey(input.key)));
  server.handle(refreshCloud, async () => fresh(await controller.refreshCloud()));

  /**
   * Brings the proxy back by hand.
   *
   * Start-up already retries for half a minute, which covers the daemon-replacing-
   * itself case this exists for. This is for when that was not enough and somebody
   * has since freed the port: without it the only cure is reloading the plugin.
   */
  server.handle(restartProxy, async () => {
    await proxy.stop().catch(() => {});
    await proxy.start().catch((failure: unknown) => log(`voice: restart failed: ${String(failure)}`));
    return fresh(await controller.status());
  });
  server.handle(setPrompt, async (input) => fresh(await controller.setPrompt(input.text)));
  server.handle(applyPatch, async () => fresh(await controller.applyPatch()));
  server.handle(revertPatch, async () => fresh(await controller.revertPatch()));
  server.handle(applyToPaseo, async () => fresh(await controller.applyToPaseo()));
  server.handle(enableSpeech, async () => fresh(await controller.enableSpeech()));
  server.handle(disableSpeech, async () => fresh(await controller.disableSpeech()));

  server.handle(installBinaryRpc, async () => {
    await installBinary();
    controller.markBinaryChanged();
    return fresh(await controller.status());
  });

  /**
   * A sample of one line, handed back as a WAV the desktop client can play from a data
   * URL. Auditioning a voice must not spend the month's allowance on a whim, so this is
   * one short sentence and nothing is cached.
   */
  server.handle(preview, async (input) => {
    const at = await controller.choice();
    const voice = input.voice ?? (at.provider === "google" ? at.googleVoice : at.voice);
    if (!voice) {
      return { wavBase64: "", seconds: 0, error: "голос не выбран" };
    }
    try {
      let pcm: Buffer;
      if (at.provider === "google") {
        if (!at.googleKey) {
          return { wavBase64: "", seconds: 0, error: "нет ключа Google" };
        }
        pcm = await speakWithGoogle({ key: at.googleKey, voice, text: input.text, rate: at.rate });
      } else {
        await engine.ensure(at.activeModel);
        engine.touch();
        const response = await fetch(`http://127.0.0.1:${engine.port}/v1/tts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ speaker: voice, text: input.text, language: at.language, rate: at.rate }),
        });
        if (!response.ok) {
          return { wavBase64: "", seconds: 0, error: `движок: ${response.status}` };
        }
        pcm = trimPadding(Buffer.from(await response.arrayBuffer()).subarray(44));
      }
      const trimmed = trimPadding(pcm);
      return { wavBase64: wavOf(trimmed).toString("base64"), seconds: durationSeconds(trimmed), error: "" };
    } catch (failure) {
      return { wavBase64: "", seconds: 0, error: failure instanceof Error ? failure.message : String(failure) };
    }
  });

  /**
   * The cue, for a phone.
   *
   * Capped, unlike the desktop's: there the audio crosses loopback and a whole track
   * costs nothing, here it crosses a relay. A minute is long enough that the loop is
   * not noticeable and small enough to send once.
   */
  const PHONE_CAP_SECONDS = 60;

  server.handle(fetchCue, async (input) => {
    try {
      const at = await controller.choice();
      const tag = `${at.cue}:${at.cueVolume}:${PHONE_CAP_SECONDS}`;
      if (input.have === tag) {
        return { tag, unchanged: true, pcmBase64: "", rate: 16_000, seconds: 0, error: "" };
      }
      const track = await renderCue(at.cue, at.cueVolume, PHONE_CAP_SECONDS);
      return {
        tag,
        unchanged: false,
        pcmBase64: track.pcm.toString("base64"),
        rate: track.rate,
        seconds: track.durationMs / 1000,
        error: "",
      };
    } catch (failure) {
      // Answered rather than thrown: the phone's fallback is the track built into it,
      // and a rejected RPC there would read as a crash rather than as "keep what you
      // have".
      const message = failure instanceof Error ? failure.message : String(failure);
      return { tag: "", unchanged: false, pcmBase64: "", rate: 16_000, seconds: 0, error: message };
    }
  });

  /** Auditions a waiting cue without spending a build to hear it. */
  server.handle(previewCue, async (input) => {
    try {
      const at = await controller.choice();
      const track = await renderCue(input.cue, at.cueVolume, input.capSeconds);
      return {
        wavBase64: wavOf(track.pcm, track.rate).toString("base64"),
        seconds: track.durationMs / 1000,
        error: "",
      };
    } catch (failure) {
      return { wavBase64: "", seconds: 0, error: failure instanceof Error ? failure.message : String(failure) };
    }
  });

  return () => {
    engine.stop();
    void proxy.stop();
  };
}
