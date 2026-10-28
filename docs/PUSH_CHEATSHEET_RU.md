# Памятка: git, commit, push и деплой

> Проект: **Enterprise System** (`C:\Users\prodd\Desktop\Разработка\enterprise-system`)
> Remote: `https://github.com/sergiodecaux/enterprise-system.git`
> Ветка: `main`
> Деплой: GitHub Actions → GitHub Pages

---

## 1. Быстрый путь (каждый день)

Открыть PowerShell в папке проекта:

```powershell
cd "C:\Users\prodd\Desktop\Разработка\enterprise-system"

# 1. Что изменилось
git status --short
git diff --stat

# 2. Проверить сборку
npm run build

# 3. Добавить изменения приложения
git add -A -- src workers tailwind.config.ts tsconfig.tsbuildinfo

# 4. Закоммитить
git commit -m "feat(chart): краткое описание изменения"

# 5. Отправить
git push origin main
```

> В PowerShell `git push` часто печатает прогресс в stderr, и строка выглядит
> как красная ошибка `NativeCommandError`. Это **не всегда** провал.
> Проверка ниже обязательна.

---

## 2. Проверка, что push реально прошёл

```powershell
git fetch origin main --quiet
git status -sb
git rev-parse HEAD
git rev-parse origin/main
```

Ожидаемо:

```text
## main...origin/main
```

и одинаковые хеши у `HEAD` и `origin/main`. Если хеши разные — push не прошёл.

Ещё один способ:

```powershell
git log --oneline -3
git log --oneline -3 origin/main
```

---

## 3. Что коммитить, а что нет

### Коммитить

```powershell
git add -A -- src workers tailwind.config.ts tsconfig.tsbuildinfo
```

- `src/**` — весь код приложения
- `workers/**` — Cloudflare Workers (backend)
- `tailwind.config.ts`, `vite.config.ts`, `package.json`, `package-lock.json`
- `docs/**` — осмысленные документы
- `scripts/**` — рабочие CLI-скрипты
- `electron/**`, `public/data/**`, `.github/**`

### Не коммитить (черновики и артефакты)

```text
ADVISOR_DIGEST.md
PROJECT_DIGEST.md
REVIEW_BUNDLE.md
SOURCE_INVENTORY_RU.md
_inventory_md_draft.md
scripts/_gen_inventory_ru.mjs
public/__chart-preview.html
public/__chart-shot.html
dist/
release/
node_modules/
tmp-visual/
*.tsbuildinfo   (кроме уже отслеживаемого tsconfig.tsbuildinfo)
```

Если случайно добавил лишнее:

```powershell
git restore --staged ADVISOR_DIGEST.md
```

Если файл попал в коммит, но ещё не запушен:

```powershell
git reset --soft HEAD~1
git restore --staged ADVISOR_DIGEST.md
git commit -m "..."
```

---

## 4. Полный сценарий с проверкой перед push

```powershell
cd "C:\Users\prodd\Desktop\Разработка\enterprise-system"

# 1. Ветка и remote
git branch --show-current          # main
git remote -v

# 2. Синхронизация с origin
git fetch origin
git status -sb

# 3. Локальная сборка (обязательно)
npm run build

# 4. Просмотр изменений
git diff --stat
git diff -- src/components/tactical/LiveChart.tsx

# 5. Индексация только нужного
git add -A -- src workers tailwind.config.ts tsconfig.tsbuildinfo docs

# 6. Проверка, что в индексе
git status --short

# 7. Коммит
git commit -m "feat(chart): auto limit cases and mobile Telegram layout"

# 8. Push
git push origin main

# 9. Проверка
git fetch origin main --quiet
git status -sb
git rev-parse HEAD
git rev-parse origin/main
```

---

## 5. Стиль сообщений коммита

Проект использует Conventional Commits:

```text
feat(scope): новая функциональность
fix(scope): исправление
refactor(scope): перестройка без изменения поведения
docs(scope): документация
chore(scope): сборка, зависимости, служебное
test(scope): тесты
```

Примеры:

```powershell
git commit -m "feat(chart): auto limit cases on bounce zones"
git commit -m "fix(sniper): refresh live limits after symbol change"
git commit -m "docs(project): add file map and push cheatsheet"
```

Если нужно тело коммита:

```powershell
git commit -m "feat(chart): auto limit cases" -m "Adds 1-5% limit orders from key zones, recalculates comments on pan/zoom."
```

---

## 6. Деплой на GitHub Pages

Push в `main` автоматически запускает workflow
`.github/workflows/deploy-pages.yml`:

1. checkout;
2. Node 20 + `npm ci`;
3. `npm run build` с секретами (`VITE_MEXC_PROXY_URL`, `VITE_ALERT_SECRET`,
   `VITE_TELEGRAM_BOT_USERNAME`, `VITE_ADVISOR_URLS`);
4. штамп `dist/version.json` (SHA коммита);
5. upload artifact;
6. deploy на GitHub Pages.

Посмотреть статус без `gh`:

```powershell
(Invoke-RestMethod "https://api.github.com/repos/sergiodecaux/enterprise-system/actions/runs?per_page=3").workflow_runs |
  Select-Object run_number, status, conclusion, head_sha, html_url |
  Format-List
```

Проверить, что на Pages лежит именно ваш коммит:

```powershell
Invoke-RestMethod "https://sergiodecaux.github.io/enterprise-system/version.json?t=$(Get-Date -UFormat %s)" |
  ConvertTo-Json
```

Поле `sha` должно совпадать с `git rev-parse HEAD`.

Открыть страницу Actions:

```text
https://github.com/sergiodecaux/enterprise-system/actions
```

---

## 7. Telegram Mini App не обновился

Причина почти всегда одна из трёх:

1. **Коммит не запушен** — проверьте `git status -sb` и сравните хеши.
2. **Сборка на GitHub упала** — откройте Actions и посмотрите шаг `Build`.
   Локальный `npm run build` должен проходить **до** push.
3. **Telegram закэшировал WebView** — закройте Mini App полностью
   (свайп вниз / крестик), откройте заново; при необходимости закройте
   и откройте Telegram.

`vite.config.ts` штампует `dist/version.json`, а приложение использует его
для сброса кэша. Если версия на Pages старая — проблема в деплое, а не в кэше.

---

## 8. Если push отклонён

### 8.1. `rejected — non-fast-forward`

Кто-то (или вы с другой машины) уже запушил в `main`.

```powershell
git fetch origin
git log --oneline HEAD..origin/main     # что есть на сервере
git log --oneline origin/main..HEAD     # что есть у вас
```

Вариант А — rebase своих коммитов поверх сервера:

```powershell
git pull --rebase origin main
npm run build
git push origin main
```

Вариант Б — merge:

```powershell
git pull origin main
npm run build
git push origin main
```

**Не делайте** `git push --force` в `main`: это перезапишет историю и может
сломать деплой. `--force-with-lease` допустим только если вы точно знаете,
что делаете, и согласовали это.

### 8.2. Ошибка авторизации

```text
Authentication failed / could not read Username
```

Проверьте, что Git Credential Manager знает аккаунт:

```powershell
git config --global user.name
git config --global user.email
git remote -v
```

Повторный push вызовет окно входа GitHub. Для HTTPS нужен Personal Access Token
(scope `repo`), для SSH — ключ в `~/.ssh`.

### 8.3. Случайно закоммитил секрет

1. Немедленно отзовите ключ/токен в панели сервиса.
2. Удалите секрет из файла и из истории (или создайте новый чистый коммит).
3. Только после отзыва — push.

Секреты воркеров задаются так:

```powershell
cd workers\mexc-proxy
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ALERT_SECRET
npx wrangler secret put FAILOVER_SECRET
```

---

## 9. Полезные команды

```powershell
# История
git log --oneline --graph --decorate -15

# Кто изменил строку
git blame src/components/tactical/LiveChart.tsx

# Отменить изменения в файле (осторожно!)
git restore src/components/tactical/LiveChart.tsx

# Убрать файл из индекса, оставив на диске
git restore --staged path\to\file

# Последний коммит
git show --stat HEAD

# Разница с origin
git diff origin/main..HEAD --stat

# Список веток
git branch -a

# Теги
git tag
```

---

## 10. Откат уже запушенного коммита

Безопасный способ — новый коммит, отменяющий изменения:

```powershell
git revert <sha>
git push origin main
```

Откат последнего **незапушенного** коммита:

```powershell
git reset --soft HEAD~1   # изменения останутся в индексе
# или
git reset --mixed HEAD~1  # изменения останутся на диске
```

Жёсткий откат (удалит незакоммиченные изменения — использовать только осознанно):

```powershell
git reset --hard HEAD~1
```

---

## 11. Мини-чеклист перед push

- [ ] `git status --short` просмотрен;
- [ ] черновики и debug-HTML не добавлены;
- [ ] `npm run build` проходит;
- [ ] сообщение коммита описывает изменение;
- [ ] `git fetch origin && git status -sb` — нет расхождения;
- [ ] после push хеши `HEAD` и `origin/main` совпадают;
- [ ] Actions завершился `success`;
- [ ] `version.json` на Pages содержит новый SHA.
