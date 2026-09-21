# Релизы

GitLab — источник правды. GitHub — зеркало и витрина релизов.

```
GitLab master ──[verify: typecheck + test + build]──> mirror:github ──force push──> GitHub master
                                                                                         │
                                                                            .github/workflows/release.yml
                                                                                         │
                                                                 тег <version> + GitHub Release с артефактами
```

## Разовая настройка

### 1. GitHub

Создать пустой репозиторий (например `muxaujl/obsidian-git-scm`), **не** инициализируя
его README — первый push придёт из GitLab и делается с `--force`.

После первого зеркалирования в Settings → General → Default branch выставить
`master` (GitHub создаёт репозиторий с `main`, а зеркало приносит `master`).

### 2. Токен

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens:

- Repository access: только созданный репозиторий
- Permissions → Repository permissions → **Contents: Read and write**
- Срок жизни: максимальный из допустимых политикой (токен придётся продлевать)

### 3. GitLab CI/CD variables

Settings → CI/CD → Variables:

| Переменная     | Значение                    | Флаги                          |
|----------------|-----------------------------|--------------------------------|
| `GITHUB_TOKEN` | fine-grained PAT            | Masked, Protected, не Expanded |
| `GITHUB_REPO`  | `muxaujl/obsidian-git-scm`  | —                              |

`Protected` работает, только если `master` отмечена как protected branch
(Settings → Repository → Protected branches). Иначе флаг надо снять, иначе
переменная не приедет в джобу и `mirror:github` не запустится по правилу
`$GITHUB_TOKEN`.

На стороне GitHub ничего настраивать не надо: workflow использует встроенный
`GITHUB_TOKEN` и объявленный `permissions: contents: write`.

## Что проверяет verify

- `npm run typecheck` — `tsc --noEmit` по `src/**`;
- `npm test` — собирает `main.js` и гоняет `node --test test/core.test.mjs`.
  Тесты работают с настоящим `git` во временных репозиториях, поэтому джоба
  требует git в образе (`node:20-bookworm` его содержит) — важно помнить, если
  менять образ на `-slim`/`alpine`.

## Как считается версия

Версия выводится из **тегов GitHub**, а не из файлов в репозитории:

- нет тегов → берётся `manifest.json.version` как есть (первый релиз — `0.1.0`);
- есть тег → `patch + 1` (`0.1.7` → `0.1.8`);
- если в `manifest.json` вручную подняли minor/major и это больше, чем
  `последний тег + patch`, побеждает `manifest.json`.

Так minor/major-релиз делается одним коммитом в GitLab с правкой
`manifest.json`, а всё остальное едет patch-ами автоматически.

**Важно:** workflow **не коммитит** поднятую версию обратно. Он правит
`manifest.json`, `package.json` и `versions.json` только в рабочей копии раннера
и кладёт их в релиз. Иначе GitHub-ветка разъехалась бы с GitLab, а следующее
зеркалирование (`--force`) затёрло бы этот коммит. Практическое следствие:
в GitLab `manifest.json` остаётся на последней версии, поставленной руками, —
это нормально, актуальную версию показывает последний тег/релиз.

## Пропустить релиз

Добавить `[skip release]` в сообщение коммита. Релиз также не создаётся, если
на HEAD уже висит тег версии (например, при повторном запуске workflow).

## Артефакты релиза

- `main.js`, `manifest.json`, `styles.css`, `versions.json` — отдельными файлами;
  этого требует каталог community plugins Obsidian;
- `git-<version>.zip` — каталог `git/` целиком, для ручной установки и BRAT.

`main.js` в репозиторий не коммитится (он в `.gitignore`) — его собирает релизный
workflow.

Тег — голая версия без префикса `v`: Obsidian требует, чтобы имя тега совпадало
с `manifest.version` символ в символ.

## Каталог Obsidian

Если плагин подаётся в официальный каталог, `versions.json` в корне репозитория
должен быть актуальным (Obsidian по нему подбирает совместимую версию для старых
сборок приложения). Так как CI не коммитит его обратно, перед подачей заявки
обнови файл руками, скопировав его из последнего релиза.
