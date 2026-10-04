import React from "react";
import { Text, View } from "react-native";
import { ChoiceRow, Group, gigabytes, KeyField, type Lab, Meter, PromptEditor, Row, Slider, Switch, VoiceRow } from "./lab.client.tsx";
import { type SectionId, tierOfVoice } from "./summary.ts";

export type { SectionId };

export type Section = {
  id: SectionId;
  title: string;
  icon: string;
  Component(lab: Lab): React.ReactElement;
};

const PROBE = "Проверка связи. Слышно меня?";

/** Google's own order, cheapest allowance last, with the one worth defaulting to first. */
const FAMILIES = [
  { id: "chirp3-hd", label: "Chirp 3 HD", hint: "новое поколение · $30 за 1 млн" },
  { id: "standard", label: "Standard", hint: "те же голоса, что WaveNet · 4 млн бесплатно" },
  { id: "wavenet", label: "WaveNet", hint: "то же звучание, но лимит вчетверо меньше" },
];

const short = (name: string) => name.replace(/^ru-RU-/, "").replace("Chirp3-HD-", "").replace(/^(Standard|Wavenet)-/, "");

function tone(theme: Lab["theme"], kind?: "ok" | "warn"): string | undefined {
  if (kind === "ok") return theme.colors.statusSuccess;
  if (kind === "warn") return theme.colors.statusWarning;
  return undefined;
}

export const SECTIONS: Section[] = [
  {
    id: "voice",
    title: "Голос",
    icon: "Mic",
    Component: (lab) => {
      const { data, theme, act } = lab;
      const cloud = data.provider === "google";
      const family = tierOfVoice(data.cloudVoice) || "chirp3-hd";
      const inFamily = data.cloudVoices.filter((voice) => voice.tier === family);

      return (
        <View>
          <Group
            theme={theme}
            title="Откуда речь"
            footer={
              cloud
                ? "Google считает вчетверо быстрее, чем говорит, поэтому пауз между предложениями нет."
                : "Локальный движок бесплатен и работает без сети, но отстаёт от речи — отсюда паузы."
            }
          >
            <ChoiceRow
              theme={theme}
              label="Провайдер"
              value={data.provider}
              options={[
                { label: "Google", value: "google" },
                { label: "Локально", value: "local" },
              ]}
              onChange={(value) => act.setProvider(value as "google" | "local")}
              last
            />
          </Group>

          {cloud ? (
            <Group
              theme={theme}
              title="Ключ Google"
              footer={
                data.keyPresent
                  ? "Лежит в файле с правами 600 и в панель не передаётся — здесь только огрызок, чтобы узнать свой."
                  : "Google Cloud Console → Credentials → Create API key. Ограничь его одним Cloud Text-to-Speech API."
              }
            >
              <KeyField
                theme={theme}
                hint={data.keyHint}
                path={data.keyPath}
                busy={act.savingKey}
                error={data.cloudError}
                onSave={(next) => act.setKey(next)}
              />
              {data.keyPresent && data.cloudError ? (
                <Row
                  theme={theme}
                  label="Google не отвечает"
                  hint={data.cloudError}
                  action="Ещё раз"
                  onPress={() => act.refreshCloud()}
                  last
                />
              ) : null}
            </Group>
          ) : null}

          {cloud && data.keyPresent ? (
            <>
              <Group theme={theme} title="Семейство">
                {FAMILIES.map((entry, index) => (
                  <Row
                    key={entry.id}
                    theme={theme}
                    label={entry.label}
                    hint={entry.hint}
                    value={family === entry.id ? "выбрано" : undefined}
                    valueColour={tone(theme, "ok")}
                    onPress={() => {
                      const first = data.cloudVoices.find((voice) => voice.tier === entry.id);
                      if (first) act.chooseCloudVoice(first.name);
                    }}
                    last={index === FAMILIES.length - 1}
                  />
                ))}
              </Group>

              <Group
                theme={theme}
                title={`Голос · ${inFamily.length}`}
                footer={
                  act.canPlay
                    ? "Кнопка справа проигрывает голос прямо здесь, повторное нажатие обрывает."
                    : "Прослушать не выйдет: это приложение не даёт плагину проигрывать звук. С компьютера работает."
                }
              >
                {inFamily.map((voice, index) => (
                  <VoiceRow
                    key={voice.name}
                    theme={theme}
                    name={short(voice.name)}
                    detail={voice.gender === "female" ? "ж" : "м"}
                    selected={voice.name === data.cloudVoice}
                    playing={act.listeningTo === voice.name ? act.listeningState : ""}
                    canPlay={act.canPlay}
                    onSelect={() => act.chooseCloudVoice(voice.name)}
                    onPlay={() => act.listen(voice.name)}
                    last={index === inFamily.length - 1}
                  />
                ))}
              </Group>
            </>
          ) : null}

          {!cloud ? (
            <Group theme={theme} title="Голос движка" footer={data.engine.running ? undefined : "Список появится, когда движок поднимется — нажми на любой голос или «Послушать»."}>
              {data.localVoices.length > 0 ? (
                data.localVoices.map((name, index) => (
                  <VoiceRow
                    key={name}
                    theme={theme}
                    name={name}
                    selected={name === data.localVoice}
                    playing={act.listeningTo === name ? act.listeningState : ""}
                    canPlay={act.canPlay}
                    onSelect={() => act.chooseLocalVoice(name)}
                    onPlay={() => act.listen(name)}
                    last={index === data.localVoices.length - 1}
                  />
                ))
              ) : (
                <Row
                  theme={theme}
                  label="Движок спит"
                  hint="Нажми «Послушать», он поднимется за несколько секунд"
                  action={act.listeningTo ? "Бужу…" : "Послушать"}
                  disabled={act.listeningTo !== "" || !act.canPlay}
                  onPress={() => act.listen()}
                  last
                />
              )}
            </Group>
          ) : null}

          <Group
            theme={theme}
            title="Как говорит"
            footer={
              (cloud
                ? ""
                : "«Ровный тон» прибивает случайность, чтобы один ответ звучал как один человек, " +
                  "а не как набор дублей. ") +
              "«Чистый звук» нужен, потому что движок в мобильном " +
              "приложении умеет только 16 кГц и понижает частоту без фильтра — всё выше " +
              "8 кГц заворачивается обратно как грязь. Этот диапазон там теряется в любом " +
              "случае, вопрос только в том, тихо или с дребезгом. На компьютере он слышен " +
              "честно, так что для настольной прослушки выключи."
            }
          >
            {/* Google has no seed to pin and does not vary between takes; the switch
                would be a control that does nothing. */}
            {!cloud ? (
              <Switch
                theme={theme}
                label="Ровный тон"
                hint="Одна манера на весь ответ"
                value={data.steady}
                onChange={(next) => act.setSteady(next)}
              />
            ) : null}
            <Switch
              theme={theme}
              label="Чистый звук на телефоне"
              hint="Срезает верх, который мобильное приложение всё равно превращает в хрип"
              value={data.phoneSafe}
              onChange={(next) => act.setPhoneSafe(next)}
            />
            <Slider
              theme={theme}
              label="Темп речи"
              hint="1,0 — как голос задуман"
              value={data.rate}
              min={data.rateMin}
              max={data.rateMax}
              format={(value) => `${value.toFixed(2).replace(".", ",")}×`}
              onSettle={(value) => act.setRate(value)}
            />
            <Row
              theme={theme}
              label="Послушать выбранный"
              hint={`Скажет: «${PROBE}»`}
              action={act.listeningTo ? "Синтезирую…" : "Слушать"}
              disabled={act.listeningTo !== "" || !act.canPlay}
              onPress={() => act.listen()}
              last
            />
          </Group>
        </View>
      );
    },
  },

  {
    id: "limits",
    title: "Лимиты",
    icon: "Gauge",
    Component: (lab) => {
      const { data, theme } = lab;
      const active = tierOfVoice(data.cloudVoice);
      const resets = data.usageResetsAt ? new Date(data.usageResetsAt) : null;
      const owed = data.usage.reduce((sum, row) => sum + row.owed, 0);

      return (
        <View>
          <Group
            theme={theme}
            title="Бесплатно в этом месяце"
            footer={
              "Считает сам плагин: каждая фраза проходит через него, так что цифра точнее " +
              "и свежее, чем у Google в консоли. Лимиты у семейств раздельные — кончилось " +
              "одно, можно перейти на другое с нетронутым."
            }
          >
            {data.usage.map((row, index) => (
              <Meter
                key={row.id}
                theme={theme}
                label={row.label}
                note={row.note}
                used={row.used}
                free={row.free}
                owed={row.owed}
                price={row.dollarsPerMillion}
                active={row.id === active}
                last={index === data.usage.length - 1}
              />
            ))}
          </Group>

          <Group theme={theme}>
            <Row
              theme={theme}
              label="Обнуление"
              hint="Лимит возвращается каждый месяц, остаток не копится"
              value={resets ? resets.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "—"}
            />
            <Row
              theme={theme}
              label="Набежало сверх лимита"
              hint={owed > 0 ? "Это и будет в счёте" : "Пока всё внутри бесплатного"}
              value={`$${owed.toFixed(2)}`}
              valueColour={tone(theme, owed > 0 ? "warn" : "ok")}
              last
            />
          </Group>
        </View>
      );
    },
  },

  {
    id: "cue",
    title: "Звук ожидания",
    icon: "Music",
    Component: (lab) => {
      const { data, theme, act } = lab;
      const own = data.cues.filter((entry) => entry.kind === "own");
      return (
        <View>
          <Group
            theme={theme}
            title="Что играет, пока агент думает"
            footer={
              (act.canPlay
                ? "Кнопка справа проигрывает прямо здесь, повторное нажатие обрывает. "
                : "Послушать не выйдет: это приложение не даёт плагину проигрывать звук. С компьютера работает. ") +
              "Встроенные качаются при первом обращении и проверяются по контрольной сумме. " +
              "Музыка — Kevin MacLeod, лицензия CC BY 4.0."
            }
          >
            {data.cues.map((entry, index) => (
              <VoiceRow
                key={entry.id}
                theme={theme}
                name={entry.title}
                detail={entry.kind === "own" ? "свой" : entry.kind === "silence" ? "тишина" : entry.seconds === 0 ? "скачать" : undefined}
                selected={entry.id === data.cue}
                playing={act.listeningTo === entry.id ? act.listeningState : ""}
                canPlay={act.canPlay && entry.kind !== "silence"}
                onSelect={() => act.chooseCue(entry.id)}
                onPlay={() => act.playCue(entry.id)}
                last={index === data.cues.length - 1}
              />
            ))}
          </Group>

          <Group
            theme={theme}
            title="Громкость"
            footer={
              "Все треки сперва приводятся к одному тихому уровню, и только потом " +
              "применяется это — иначе ползунок значил бы разное для сгенерированного " +
              "и для скачанного. Слышно со следующего повтора, ничего перекладывать не надо."
            }
          >
            <Slider
              theme={theme}
              label="Громкость фона"
              hint="1,0 — как задумано; 0 — совсем тихо"
              value={data.cueVolume}
              min={0}
              max={data.cueVolumeMax}
              format={(value) => (value === 0 ? "тихо" : `${value.toFixed(2).replace(".", ",")}\u00d7`)}
              onSettle={(value) => act.setCueVolume(value)}
              last
            />
          </Group>

          <Group
            theme={theme}
            title="Свои треки"
            footer={
              "Кидай сюда что угодно — mp3, m4a, wav, flac. Появится в списке сам, " +
              "переведётся в нужный формат, длинное обрежется до двенадцати секунд, " +
              "а края приглушатся, чтобы на повторе не щёлкало."
            }
          >
            <Row
              theme={theme}
              label="Папка"
              hint={data.cueFolder}
              value={own.length > 0 ? `${own.length} шт.` : "пусто"}
              valueColour={tone(theme, own.length > 0 ? "ok" : undefined)}
              last
            />
          </Group>

          <Group
            theme={theme}
            footer={
              "На компьютере патч заставляет Paseo спрашивать звук у плагина, поэтому трек " +
              "и громкость меняются на лету — ни перепатчивать, ни перезапускать не надо. " +
              "На телефоне так не выйдет: там звук вшит в приложение, обновлений по воздуху " +
              "нет, файлы внутри запечатаны подписью — только пересборка."
            }
          >
            <Row
              theme={theme}
              label="На компьютере"
              hint="Нужен патч — он учит Paseo спрашивать звук у плагина. Накладывается один раз"
              value={data.patch.targets.find((one) => one.id === "cue")?.applied ? "работает" : "нужен патч"}
              valueColour={tone(theme, data.patch.targets.find((one) => one.id === "cue")?.applied ? "ok" : "warn")}
            />
            <Row
              theme={theme}
              label="На телефоне"
              hint="Пересобрать приложение с выбранным звуком и залить кабелем"
              value="ios-build/build.sh"
              last
            />
          </Group>
        </View>
      );
    },
  },

  {
    id: "patch",
    title: "Патч Paseo",
    icon: "Wrench",
    Component: (lab) => {
      const { data, theme, act } = lab;
      const { patch } = data;
      return (
        <View>
          <Group
            theme={theme}
            title="Правки в коде Paseo"
            footer={
              "Первая: Paseo оставляет тело ответа непрочитанным, пока не доиграет " +
              "предыдущее предложение, а HTTP-клиент тем временем его выбрасывает — " +
              "предложение пропадает молча. Вторая: он режет по каждой точке и не " +
              "склеивает, отсюда паузы. Третья: мьют обрывает поток, а детектор конца " +
              "фразы считает время только по входящему звуку — и сказанное остаётся " +
              "неотправленным. У детектора есть flush, которым в демоне никто не пользуется."
            }
          >
            {patch.targets.map((target, index) => (
              <Row
                key={target.id}
                theme={theme}
                label={target.title}
                hint={target.unknownVersion ? "Код в этой версии Paseo изменился — якоря не совпали" : target.note}
                value={target.applied ? "включено" : "нет"}
                valueColour={tone(theme, target.applied ? "ok" : "warn")}
                last={index === patch.targets.length - 1}
              />
            ))}
          </Group>

          <Group
            theme={theme}
            footer={
              patch.restartRequired
                ? "Записано. Демон держит старый код в памяти — нужен полный перезапуск Paseo, не reload."
                : "Длина файла сохраняется байт в байт, поэтому архив не перепаковывается и подпись не ломается сильнее, чем уже. Оригинал сохраняется рядом, откат мгновенный."
            }
          >
            <Row
              theme={theme}
              label="Архив"
              hint={patch.archivePath || "app.asar не найден"}
              value={patch.available ? "найден" : "нет"}
              valueColour={tone(theme, patch.available ? "ok" : "warn")}
            />
            <Row
              theme={theme}
              label={patch.applied ? "Откатить" : "Наложить"}
              hint={
                patch.unknownVersion
                  ? "Paseo обновился и код изменился — патч не подойдёт, нужны новые якоря"
                  : patch.applied
                    ? "Вернёт сохранённый оригинал"
                    : "Запишет обе правки и сохранит оригинал"
              }
              action={act.patching ? "Пишу…" : patch.applied ? "Откатить" : "Наложить"}
              disabled={act.patching || !patch.available || patch.unknownVersion}
              onPress={() => (patch.applied ? act.revertPatch() : act.applyPatch())}
              last
            />
          </Group>

          {patch.error ? (
            <Group theme={theme}>
              <Row theme={theme} label="Ошибка" hint={patch.error} last />
            </Group>
          ) : null}
        </View>
      );
    },
  },

  {
    id: "local",
    title: "Локальный движок",
    icon: "Cpu",
    Component: (lab) => {
      const { data, theme, act } = lab;
      if (!data.localSupported) {
        return (
          <Group theme={theme} footer="Движок собран под macOS на Apple silicon.">
            <Row theme={theme} label="Не та платформа" last />
          </Group>
        );
      }
      const installed = data.localModels.filter((model) => model.installed);
      return (
        <View>
          <Group
            theme={theme}
            title="Запасной вариант"
            footer={
              "Нужен, когда нет сети или ключа. Качеством и скоростью уступает Google, " +
              "поэтому здесь только самое необходимое — скачивание моделей отсюда убрано."
            }
          >
            <Row
              theme={theme}
              label="Движок"
              hint={data.binaryInstalled ? "qwen_tts на месте" : "Нужен бинарь, 1,4 МБ"}
              value={data.binaryInstalled ? "установлен" : undefined}
              valueColour={tone(theme, "ok")}
              action={data.binaryInstalled ? undefined : act.installingEngine ? "Ставлю…" : "Поставить"}
              disabled={act.installingEngine}
              onPress={() => act.installEngine()}
            />
            <Row
              theme={theme}
              label="Состояние"
              hint={data.engine.error || undefined}
              value={data.engine.running ? `работает · ${data.engine.model}` : "спит"}
              valueColour={tone(theme, data.engine.running ? "ok" : undefined)}
              last={installed.length === 0}
            />
            {installed.length > 0 ? (
              <ChoiceRow
                theme={theme}
                label="Модель"
                hint="1.7B читает по-русски чище, 0.6B быстрее"
                value={data.activeModel}
                options={installed.map((model) => ({
                  label: model.label,
                  value: model.id,
                  detail: gigabytes(model.onDisk),
                }))}
                onChange={(value) => act.chooseModel(value)}
                last
              />
            ) : null}
          </Group>

          {installed.length === 0 ? (
            <Group theme={theme} footer="Модели лежат в ~/.paseo-voice/models. Положи туда веса с Hugging Face, и движок их подхватит.">
              <Row theme={theme} label="Моделей на диске нет" last />
            </Group>
          ) : null}
        </View>
      );
    },
  },

  {
    id: "dictation",
    title: "Диктовка",
    icon: "Keyboard",
    Component: (lab) => {
      const { data, theme } = lab;
      return (
        <Group
          theme={theme}
          title="Модель распознавания"
          footer={`Её читает paseo-whisper из ${data.whisper.directory}. Плагин только показывает, на месте ли файл — чужой конфиг он не трогает.`}
        >
          <Row
            theme={theme}
            label={data.whisper.name}
            hint={data.whisper.installed ? gigabytes(data.whisper.onDisk) : `нужно ${gigabytes(data.whisper.bytes)}`}
            value={data.whisper.installed ? "на месте" : "нет"}
            valueColour={tone(theme, data.whisper.installed ? "ok" : "warn")}
            last
          />
        </Group>
      );
    },
  },

  {
    id: "speech",
    title: "Речь агента",
    icon: "Settings",
    Component: (lab) => {
      const { data, theme, act } = lab;
      const { settings } = data;
      const on = settings.mcpInjected && settings.promptSet;
      return (
        <View>
          <Group
            theme={theme}
            title="Настройки демона"
            footer={
              "Первая отдаёт агенту MCP-сервер Paseo, в котором живёт инструмент speak — без неё " +
              "разговор слышит, но ответить ему нечем. Вторая дописывает в системный промпт правило: " +
              "проговаривать всё, что сказано человеку, а команды и код оставлять на экране. Обе лежат в " +
              settings.configPath + "."
            }
          >
            <Row
              theme={theme}
              label="Инструмент speak"
              hint="daemon.mcp.injectIntoAgents · по умолчанию выключено"
              value={settings.mcpInjected ? "включено" : "выключено"}
              valueColour={tone(theme, settings.mcpInjected ? "ok" : "warn")}
            />
            <Row
              theme={theme}
              label="Озвучивать всё"
              hint={settings.foreignPrompt ? "В промпте уже есть чужая инструкция — наша добавится после неё" : "daemon.appendSystemPrompt"}
              value={settings.promptSet ? "включено" : "нет"}
              valueColour={tone(theme, settings.promptSet ? "ok" : undefined)}
              last
            />
          </Group>

          <Group
            theme={theme}
            title="Текст инструкции"
            footer={
              "Это и есть правило, по которому агент решает, что сказать голосом, а что " +
              "оставить на экране. Дописывается в конец системного промпта каждого агента. " +
              "Сохранение сразу подменяет его в конфиге и просит демон перечитать — новый " +
              "чат подхватит, открытые доработают по-старому."
            }
          >
            <PromptEditor
              theme={theme}
              value={data.prompt.text}
              isDefault={data.prompt.isDefault}
              busy={act.savingPrompt}
              onSave={(next) => act.setPrompt(next)}
              onReset={() => act.setPrompt(data.prompt.defaultText)}
            />
          </Group>

          <Group theme={theme} footer="Применяется без перезапуска: демон перечитывает конфиг сам. Новый чат подхватит сразу.">
            <Row
              theme={theme}
              label={on ? "Выключить" : "Включить"}
              hint={on ? "Вернёт обе настройки, чужой промпт не тронет" : "Включит обе и перечитает конфиг"}
              action={act.switching ? "Применяю…" : on ? "Выключить" : "Включить"}
              disabled={act.switching}
              onPress={() => (on ? act.disableSpeech() : act.enableSpeech())}
              last
            />
          </Group>

          {settings.error ? (
            <Group theme={theme}>
              <Row theme={theme} label="Ошибка" hint={settings.error} last />
            </Group>
          ) : null}
        </View>
      );
    },
  },

  {
    id: "paseo",
    title: "Подключение",
    icon: "Link",
    Component: (lab) => {
      const { data, theme, act } = lab;
      return (
        <View>
          <Group
            theme={theme}
            title="Режим разговора"
            footer={
              "Прописывает в конфиг Paseo, что синтез речи берётся отсюда. Распознавание " +
              "не трогается. Демон читает провайдеров один раз при старте, поэтому нужен перезапуск."
            }
          >
            <Row
              theme={theme}
              label="Куда смотрит Paseo"
              hint="providers.openai.tts.baseUrl"
              value={data.wired ? "на плагин" : "мимо"}
              valueColour={tone(theme, data.wired ? "ok" : "warn")}
            />
            <Row
              theme={theme}
              label="Прописать"
              hint={data.restartRequired ? "Записано — перезапусти Paseo" : "Запишет и попросит перезапуск"}
              action={act.applying ? "Пишу…" : "Прописать"}
              disabled={act.applying}
              onPress={() => act.apply()}
              last
            />
          </Group>
        </View>
      );
    },
  },
];
