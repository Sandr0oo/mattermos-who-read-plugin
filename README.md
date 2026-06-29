# Плагин для отметки о прочтении сообщения.
Написал этот плагин, потому что наша команда переехала из скайпа и всем очень не хватало отметок о прочетении сообщения.
Работает со стороны клиента, серверной части вообще нет. 
То как работает плагин представленно на скриншоте. 
![VirtualBoxVM_34RhbTFdQl](https://github.com/Sandr0oo/mattermos-who-read-plugin/assets/61181414/863df87d-a2bf-40c6-b554-4e74c2e89f13)

## Как это работает

Плагин не добавляет отдельную серверную модель read receipts. Отметка о прочтении хранится и показывается обычной реакцией `:eyes:` от имени пользователя, который прочитал сообщение.

Чтобы не засорять историю реакциями на каждом сообщении, плагин переносит `:eyes:` на последний прочитанный пост в канале или треде. Если пользователь прочитал более новое сообщение, старую свою `:eyes:` плагин снимает и ставит новую. Если последний пост написал сам пользователь, новая реакция не ставится.

Ограничения текущего подхода:

- `:eyes:` видна как обычная Mattermost-реакция, это не отдельный UI read receipts.
- Серверной части нет, поэтому плагин опирается на WebSocket events Mattermost и стандартные API реакций.
- Локальное состояние в браузере используется только как вспомогательная оптимизация; источником видимого состояния остаётся реакция в Mattermost.
- Если операция добавления или удаления реакции не прошла, плагин не должен записывать новое успешное состояние и попробует снова при следующем событии чтения.
- Для полноценного read receipts без реакций нужен отдельный server-side механизм хранения и собственный UI.

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

После успешного обновления плагина нужно обновить вкладку Mattermost в браузере.

### Первый запуск

```bash
docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev
```

Эта команда:

1. Поднимает PostgreSQL и Mattermost 9.11.
2. Генерирует `webapp/src/manifest.ts`.
3. Собирает `webapp/dist/main.js`.
4. Упаковывает архив `dist/com.mattermost.who-read-plugin-<version>.tar.gz`.
5. Создает команду `test-team` и тестовых пользователей.
6. Устанавливает плагин в Mattermost через `mmctl plugin add --force`.

После запуска:

- Mattermost: http://localhost:8065
- `admin@example.com` / `AdminPass123!`
- `alice@example.com` / `Password123!`
- `bob@example.com` / `Password123!`

`plugin-dev` - это одноразовый helper-контейнер. Он сделал работу и завершился. Сам Mattermost после этого продолжает работать в контейнере `who-read-mm9`.

### После изменений в коде

1. Изменил код.
2. Запустил:

    ```bash
    docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev deploy
    ```

3. Дождался в консоли:

    ```text
    Added plugin: /src/dist/com.mattermost.who-read-plugin-<version>.tar.gz
    Enabled plugin: com.mattermost.who-read-plugin
    ```

4. Обновил вкладку Mattermost в браузере.

Команда `deploy` не создает пользователей заново. Она только пересобирает webapp, пакует архив и переустанавливает плагин.

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

### Ручная матрица проверки

Минимальная проверка после изменений:

1. Зайти в Mattermost под `alice@example.com` и `bob@example.com` в разных браузерах или профилях.
2. От имени Alice написать сообщение в обычный канал `test-team`.
3. Открыть канал под Bob и убедиться, что на последнем сообщении Alice появилась реакция Bob `:eyes:`.
4. Написать ещё одно сообщение от Alice, открыть/прочитать канал под Bob и убедиться, что `:eyes:` Bob перенеслась на новое сообщение.
5. Написать сообщение от Bob и убедиться, что Bob не ставит `:eyes:` на собственный последний пост, а старая отметка не остаётся на неправильном сообщении.
6. Создать тред с несколькими ответами от Alice, открыть тред под Bob и убедиться, что `:eyes:` Bob стоит на последнем чужом ответе в треде.
7. Оставить окно Bob неактивным, добавить новый ответ в тред от Alice, вернуть фокус Bob и убедиться, что отложенная отметка догоняет последний ответ.
8. Обновить вкладку Bob и повторить чтение канала: плагин не должен дублировать `:eyes:` на том же посте.
9. Переустановить или disable/enable плагин, обновить вкладки и проверить, что WebSocket handlers не дублируют операции с реакциями.
10. Проверить список плагинов через `docker compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev list` или `docker exec who-read-mm9 mmctl --local plugin list`.

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
