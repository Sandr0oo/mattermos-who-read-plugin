# Плагин для отметки о прочтении сообщения.
Написал этот плагин, потому что наша команда переехала из скайпа и всем очень не хватало отметок о прочетении сообщения.
Работает со стороны клиента, серверной части вообще нет. 
То как работает плагин представленно на скриншоте. 
![VirtualBoxVM_34RhbTFdQl](https://github.com/Sandr0oo/mattermos-who-read-plugin/assets/61181414/863df87d-a2bf-40c6-b554-4e74c2e89f13)

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
