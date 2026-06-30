# Плагин для отметки о прочтении сообщения.
Написал этот плагин, потому что наша команда переехала из скайпа и всем очень не хватало отметок о прочетении сообщения.
Сейчас плагин поддерживает старый клиентский режим через реакции и новые server/hybrid режимы с server API, KV storage и отдельным webapp UI.
То как работает плагин представленно на скриншоте. 
![VirtualBoxVM_34RhbTFdQl](https://github.com/Sandr0oo/mattermos-who-read-plugin/assets/61181414/863df87d-a2bf-40c6-b554-4e74c2e89f13)

## Как это работает

Плагин отслеживает последний прочитанный пост в канале или треде. В legacy-режиме видимое состояние хранится обычной реакцией `:eyes:`. В server/hybrid режимах read state сохраняется на стороне плагина, а web/desktop показывает собственный компактный индикатор прочтений.

Чтобы не засорять историю реакциями на каждом сообщении, в `legacy_reactions` плагин переносит `:eyes:` на последний прочитанный пост в канале или треде. В `hybrid_server` сервер по тем же правилам переносит mirror reaction (`:who_read_eyes:` или fallback `:eyes:`). Если последний пост написал сам пользователь, новая видимая реакция не ставится.

## Режимы

- `legacy_reactions` — режим по умолчанию и поведение старых версий. Работает через webapp и стандартные Mattermost reactions: ставит/переносит `:eyes:` на последний чужой прочитанный пост, серверное read-state хранилище и custom UI не используются.
- `hybrid_server` — web/desktop пишет read state через server API, сервер хранит индекс прочитавших и отдаёт данные для custom UI. Для совместимости с mobile сервер зеркалирует состояние отдельной реакцией, по умолчанию `:who_read_eyes:`.
- `server_web_only` — web/desktop пишет read state через server API и показывает custom UI, но mirror reactions не используются. В native mobile такие отметки не видны.

Legacy-режим остаётся дефолтом, поэтому после обновления поведение не меняется, пока администратор явно не переключит `readReceiptMode` в настройках плагина.

## Browser/Desktop vs Mobile flow

- Browser и desktop запускают webapp plugin. В server/hybrid режимах они обрабатывают Mattermost events `multiple_channels_viewed` и `thread_read_changed`, вызывают server API и показывают собственный индикатор `✓ <count>` под постом.
- Native mobile не исполняет webapp plugin, поэтому сам по себе не отправляет read-state события плагину и не рисует custom UI.
- В `hybrid_server` mobile видит обычную Mattermost reaction, которую сервер зеркалирует на последний прочитанный пост. Это fallback для просмотра статуса, а не полноценная mobile read detection.
- В `server_web_only` данные есть только в server storage и web/desktop UI; mobile-клиент их не показывает.

## Mirror emoji `who_read_eyes`

Для `hybrid_server` рекомендуется отдельная custom emoji `who_read_eyes`. Её нужно создать вручную в Mattermost до включения режима: плагин только проверяет наличие emoji и не создаёт её автоматически.

Если `who_read_eyes` не создана, серверное состояние и web UI продолжают работать, но зеркальная реакция не ставится. Можно включить `fallbackToStandardEyes`, тогда вместо custom emoji будет использоваться стандартная `:eyes:`. Tradeoff такого fallback: `:eyes:` снова выглядит как обычная пользовательская реакция, может конфликтовать с legacy-режимом или ручными реакциями и хуже отделяет служебные read receipts от обычного UI.

Флаг `hideMirrorReactionsInWeb` пытается скрывать служебную mirror reaction в browser/desktop, чтобы там оставался только custom indicator. Webapp берёт effective emoji из `/api/v1/emoji/status`, поэтому при включённом fallback скрывает именно фактически используемую реакцию. На mobile reaction остаётся видимой, потому что это и есть fallback.

## Server API, storage и WebSocket

Server API доступен внутри plugin route `/plugins/com.mattermost.who-read-plugin`; ключевые endpoints:

- `GET /api/v1/config` — отдаёт настройки read receipts для webapp.
- `GET /api/v1/emoji/status` — проверяет configured/effective mirror emoji и fallback.
- `POST /api/v1/read-state` — сохраняет read state текущего пользователя для `channel` или `thread`, обновляет reader index и, в `hybrid_server`, переносит mirror reaction.
- `POST /api/v1/readers/batch` — возвращает счётчики и список readers для набора post IDs с учётом прав доступа, `retentionDays` и `maxReadersPerPost`.
- `POST /api/v1/admin/cleanup-retention` — админская очистка устаревших KV read receipts по `retentionDays`; доступна только пользователям с правом `manage_system`.

В KV storage используются ключи:

- `rr:v1:state:<scope_type>:<scope_id>:user:<user_id>` — последнее прочитанное состояние пользователя в канале или треде.
- `rr:v1:post:<post_id>:readers` — индекс пользователей, которые сейчас считаются прочитавшими конкретный пост.

Server публикует WebSocket events `custom_com.mattermost.who-read-plugin_read_receipt_updated` и `custom_com.mattermost.who-read-plugin_read_receipt_config_changed`. Webapp слушает их и обновляет custom UI без полной перезагрузки страницы. Payload `read_receipt_updated` не содержит `user_id`; подробности о читателях webapp запрашивает через `/readers/batch` с учётом privacy-настроек.

## Privacy и admin settings

- `showReaderNames` управляет тем, отдаёт ли `/readers/batch` подробный массив `readers`. Если настройка выключена, API возвращает только `count` по посту, а `readers` остаётся пустым; `user_id` и имена не раскрываются.
- `retentionDays` ограничивает, какие readers попадают в API-ответ по давности. `0` отключает фильтр и cleanup по сроку.
- `POST /api/v1/admin/cleanup-retention` удаляет старые reader-index записи и read-state записи из KV storage по текущему `retentionDays`.
- `maxReadersPerPost` ограничивает размер массива `readers` в API-ответе. Поле `count` показывает общий count после применения retention-фильтра.
- В storage сохраняются технические данные read receipts: `user_id`, channel/thread scope, post IDs, mirror emoji name и timestamps. Тело сообщений и содержимое файлов плагин не сохраняет.

## Migration и rollback

- После обновления режим по умолчанию — `legacy_reactions`, поэтому существующие установки продолжают работать через `:eyes:`.
- Переключение делается через plugin settings (`readReceiptMode`, mirror/fallback/privacy параметры). После смены режима лучше обновить открытые вкладки Mattermost, чтобы webapp заново зарегистрировал нужные handlers/components.
- При переходе в `hybrid_server` server storage начинает наполняться по мере новых read events; старые `:eyes:` reactions не мигрируются в KV автоматически.
- Плагин не удаляет массово старые legacy reactions или старые mirror reactions при переключении режимов. Они уходят только через обычную логику переноса/удаления или вручную.
- Rollback — вернуть `readReceiptMode` в `legacy_reactions` и обновить клиенты. Server KV данные останутся в plugin storage, но legacy-логика снова будет опираться на стандартную `:eyes:` reaction.

## Known limitations

- Native mobile read detection без hook на стороне Mattermost core не реализован: mobile может видеть только mirrored reaction из `hybrid_server`.
- Auto-provision custom emoji невозможен через используемый Mattermost plugin API `v0.0.6`; `who_read_eyes` нужно создать вручную.
- CSS hiding для mirror reactions в web/desktop хрупкий: он зависит от DOM/classes Mattermost и может потребовать правки после обновления Mattermost.

## Совместимость Mattermost

Минимальная версия сервера в `plugin.json`: Mattermost `9.0.0`.

Причина: текущая клиентская логика использует WebSocket events `multiple_channels_viewed` и `thread_read_changed`. В Mattermost `6.2.1` уже есть `thread_read_changed`, но для каналов используется старый event `channel_viewed`; `multiple_channels_viewed` появился в линейке Mattermost 9. Поэтому fallback для Mattermost 6-8 сейчас не заявлен.

Локальный docker-стенд использует Mattermost `9.11`, то есть покрывает заявленную совместимость.

## Локальный стенд Mattermost 9

Для локальной проверки нужен только Docker. PowerShell, Go, Node и make локально не нужны: сборка плагина и `mmctl` запускаются внутри helper-контейнера `plugin-dev`.

### Коротко

После изменений в плагине руками запускаешь deploy:

```bash
docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev deploy
```

Если стенд запущен в rootless Docker context, используй тот же вариант с явным context:

```bash
DOCKER_HOST= docker --context rootless compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev deploy
```

После успешного обновления плагина нужно обновить вкладку Mattermost в браузере.

### Первый запуск

```bash
docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev
```

Эта команда:

1. Поднимает PostgreSQL и Mattermost 9.11.
2. Ждет готовности Mattermost через `mmctl --local system status`.
3. Создает или чинит тестовых пользователей `admin`, `alice`, `bob`: verify/activate, сбрасывает dev-пароли, для `admin` гарантирует `system_admin`; затем создает команду `test-team`.
4. Генерирует `webapp/src/manifest.ts`.
5. Если в проекте есть server plugin, собирает `server/dist/*` для `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64.exe`; затем собирает `webapp/dist/main.js`.
6. Упаковывает архив `dist/com.mattermost.who-read-plugin-<version>.tar.gz`.
7. Проверяет архив и устанавливает плагин в Mattermost через `mmctl plugin add --force`.
8. Включает плагин через `mmctl plugin enable` и проверяет, что он попал в секцию enabled.

После запуска:

- Mattermost: http://localhost:8065
- `admin@example.com` / `AdminPass123!`
- `alice@example.com` / `Password123!`
- `bob@example.com` / `Password123!`

`plugin-dev` - это одноразовый helper-контейнер. Он сделал работу и завершился. Сам Mattermost после этого продолжает работать в контейнере `who-read-mm9`.

Проверить, что пользователи действительно есть:

```bash
docker exec who-read-mm9 mmctl --local user search admin@example.com
docker exec who-read-mm9 mmctl --local user search alice@example.com
docker exec who-read-mm9 mmctl --local user search bob@example.com
```

В выводе каждой команды должна быть соответствующая пара username/email.

### После изменений в коде

1. Изменил код.
2. Запустил:

    ```bash
    docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev deploy
    ```

3. Дождался в консоли:

    ```text
    Added plugin: /src/dist/com.mattermost.who-read-plugin-<version>.tar.gz
    plugin enabled: com.mattermost.who-read-plugin
    ```

    Warning от `mmctl plugin enable` допустим, если после него есть строка `plugin enabled: com.mattermost.who-read-plugin`, а `plugin list` показывает плагин в enabled-секции.

4. Обновил вкладку Mattermost в браузере.

Команда `deploy` не создает пользователей заново. Она только пересобирает server/webapp, пакует архив вместе с `server/dist` и переустанавливает плагин.

### Проверить, что плагин прокинулся

```bash
docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev list
```

В выводе должен быть включенный плагин:

```text
Listing enabled plugins
com.mattermost.who-read-plugin: ...
```

Или напрямую:

```bash
docker exec who-read-mm9 mmctl --local plugin list
```

Плагин должен быть именно в секции `Listing enabled plugins`, а не только в disabled/inactive.

### Troubleshooting локального стенда

#### В Mattermost 0 users

`setup` создает пользователей до тяжелой сборки плагина, поэтому даже ошибка build/package не должна оставлять чистый стенд без `admin`, `alice`, `bob`. Проверь готовность Mattermost и пользователей:

```bash
docker exec who-read-mm9 mmctl --local system status
docker exec who-read-mm9 mmctl --local user search admin@example.com
docker exec who-read-mm9 mmctl --local user search alice@example.com
docker exec who-read-mm9 mmctl --local user search bob@example.com
```

Если пользователей нет, запусти setup повторно:

```bash
docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev
```

Для полностью чистого стенда можно удалить volumes и снова выполнить setup:

```bash
docker compose -f docker-compose.mattermost9.yml down -v
docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev
```

#### Плагин отсутствует или не включен

`deploy`/`setup` перед загрузкой проверяет непустой `dist/com.mattermost.who-read-plugin-<version>.tar.gz`, валидность `tar -tzf`, затем делает `mmctl plugin add --force` и `mmctl plugin enable`. После этого скрипт отдельно проверяет enabled-секцию `mmctl plugin list`.

`mmctl plugin enable` ограничен `PLUGIN_ENABLE_TIMEOUT_SECONDS` (по умолчанию 60 секунд): при таймауте скрипт предупреждает и всё равно проверяет enabled-секцию через `plugin list`.

Проверка:

```bash
docker exec who-read-mm9 mmctl --local plugin list
```

Если `com.mattermost.who-read-plugin` не в `Listing enabled plugins`, перезапусти deploy и смотри ошибку скрипта: он должен вывести проблему с архивом, upload/enable или итоговый `plugin list`.

```bash
docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev deploy
```

### Ручная матрица проверки

Минимальная проверка после изменений делается отдельно для legacy и hybrid режимов. После смены plugin settings обновляй вкладки Alice/Bob.

#### `legacy_reactions`

1. В настройках плагина выбрать `readReceiptMode = legacy_reactions`, сохранить настройки и обновить вкладки.
2. Зайти в Mattermost под `alice@example.com` и `bob@example.com` в разных браузерах или профилях.
3. От имени Alice написать сообщение в обычный канал `test-team`.
4. Открыть канал под Bob и убедиться, что на последнем сообщении Alice появилась реакция Bob `:eyes:`.
5. Написать ещё одно сообщение от Alice, открыть/прочитать канал под Bob и убедиться, что `:eyes:` Bob перенеслась на новое сообщение.
6. Написать сообщение от Bob и убедиться, что Bob не ставит `:eyes:` на собственный последний пост, а старая отметка не остаётся на неправильном сообщении.
7. Создать тред с несколькими ответами от Alice, открыть тред под Bob и убедиться, что `:eyes:` Bob стоит на последнем чужом ответе в треде.
8. Оставить окно Bob неактивным, добавить новый ответ в тред от Alice, вернуть фокус Bob и убедиться, что отложенная отметка догоняет последний ответ.
9. Обновить вкладку Bob и повторить чтение канала: плагин не должен дублировать `:eyes:` на том же посте.
10. Переустановить или disable/enable плагин, обновить вкладки и проверить, что WebSocket handlers не дублируют операции с реакциями.

#### `hybrid_server`

1. Создать custom emoji `who_read_eyes` вручную в Mattermost.
2. В настройках плагина выбрать `readReceiptMode = hybrid_server`, оставить `mirrorReactionsEnabled = true`, `hideMirrorReactionsInWeb = true`, `fallbackToStandardEyes = false`, сохранить настройки и обновить вкладки.
3. Зайти под Alice и Bob в разных браузерах или профилях.
4. От имени Alice написать сообщение в обычный канал `test-team`, открыть канал под Bob и убедиться, что в web/desktop под постом появился custom indicator `✓ 1`.
5. Проверить mobile fallback: в native mobile или при временно выключенном `hideMirrorReactionsInWeb` на том же посте видна mirror reaction Bob `:who_read_eyes:`.
6. Написать ещё одно сообщение от Alice, открыть/прочитать канал под Bob и убедиться, что custom indicator и mirror reaction перенеслись на новое сообщение.
7. Написать сообщение от Bob и убедиться, что Bob не появляется как reader на собственном последнем посте, а старая отметка не остаётся на неправильном сообщении.
8. Создать тред с несколькими ответами от Alice, открыть тред под Bob и убедиться, что custom indicator и mirror reaction относятся к последнему чужому ответу в треде.
9. Оставить окно Bob неактивным, добавить новый ответ в тред от Alice, вернуть фокус Bob и убедиться, что отложенная отметка догоняет последний ответ.
10. Обновить вкладку Bob и повторить чтение канала: `/read-state` не должен создавать дубли, а `/readers/batch` должен возвращать корректный `count`.
11. Переустановить или disable/enable плагин, обновить вкладки и проверить, что WebSocket handlers не дублируют server API calls или mirror reactions.
12. Проверить список плагинов через `docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev list` или `docker exec who-read-mm9 mmctl --local plugin list`.

Для быстрой проверки `server_web_only` повтори основные пункты `hybrid_server`, но ожидай custom indicator без mirror reactions и без видимости read receipts в native mobile.

### Телеметрия и шумные логи Mattermost

В тестовом compose telemetry/diagnostics отключена, а консольные логи приглушены до warnings:

```yaml
MM_LOGSETTINGS_CONSOLELEVEL: WARN
MM_LOGSETTINGS_ENABLEDIAGNOSTICS: "false"
```

Если меняешь эту настройку в уже запущенном стенде, пересоздай контейнер Mattermost:

```bash
docker compose -f docker-compose.mattermost9.yml up -d --force-recreate mattermost
```

### Остановить стенд

```bash
docker compose -f docker-compose.mattermost9.yml down
```

Полностью удалить данные стенда:

```bash
docker compose -f docker-compose.mattermost9.yml down -v
```

# Частые вопросы
### Почему реакция сбрасывается\снимается с сообщения и перескакивает на новое?
Это сделано, чтобы не засорять место огромным количеством реакций с "глазками" на каждом сообщении. Логика такая - если человек увидел какое-то сообщение, то мы можем с уверенностью сказать, что все предыдущие он уже видел и снять "глазки" с старого сообщения.
