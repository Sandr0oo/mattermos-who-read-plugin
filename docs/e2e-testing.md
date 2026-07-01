# E2E Testing Runbook — who-read-plugin

## Prerequisites

- Docker (rootless context на этом хосте)
- Mattermost 9 стенд из `docker-compose.mattermost9.yml`

## Запуск стенда

```bash
# Первый запуск (создаёт пользователей, собирает и устанавливает плагин)
DOCKER_HOST= docker --context rootless compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev

# Пересборка после изменений в коде
DOCKER_HOST= docker --context rootless compose -f docker-compose.mattermost9.yml --profile dev run --rm plugin-dev deploy

# Проверить статус плагина
DOCKER_HOST= docker --context rootless exec who-read-mm9 mmctl --local plugin list
```

## Учётные данные

| Роль    | Email                | Пароль          |
|---------|----------------------|-----------------|
| Admin   | admin@example.com    | AdminPass123!   |
| Alice   | alice@example.com    | Password123!    |
| Bob     | bob@example.com      | Password123!    |

URL: http://localhost:8065
Team: test-team

## Автоматический E2E smoke-тест

```bash
# API-only тесты (быстро, без браузера)
NO_BROWSER=1 node scripts/e2e/e2e-smoke.mjs

# С браузерными тестами (запускает Playwright в Docker)
node scripts/e2e/e2e-smoke.mjs
```

Скрипт проверяет:
1. Plugin config API возвращает корректные настройки
2. Сохранение настроек через PATCH /api/v4/config/patch
3. OnConfigurationChange срабатывает без disable/enable
4. POST /api/v4/plugins/:id/enable не зависает
5. Legacy reactions: Alice пишет → Bob читает → :eyes: появляется
6. Plugin активен в API

## Ручная матрица проверки

### 1. Настройки плагина не сохраняются

1. Зайти под admin: http://localhost:8065/login
2. System Console → Plugins → Уведомления о прочтении сообщения
3. Изменить readReceiptMode (например, на hybrid_server)
4. Нажать Save
5. **Ожидаемый баг**: индикатор сохранения крутится бесконечно
6. Проверить через API:
   ```bash
   TOKEN=$(curl -s -i -X POST http://localhost:8065/api/v4/users/login \
     -H 'Content-Type: application/json' \
     -d '{"login_id":"admin@example.com","password":"AdminPass123!"}' \
     | grep -i '^Token:' | awk '{print $2}' | tr -d '\r\n')
   curl -s http://localhost:8065/plugins/com.mattermost.who-read-plugin/api/v1/config \
     -H "Authorization: Bearer $TOKEN"
   ```
7. Если config не обновился, попробовать disable/enable:
   ```bash
   DOCKER_HOST= docker --context rootless exec who-read-mm9 mmctl --local plugin disable com.mattermost.who-read-plugin
   DOCKER_HOST= docker --context rootless exec who-read-mm9 mmctl --local plugin enable com.mattermost.who-read-plugin
   ```

### 2. Legacy reactions (:eyes:)

1. Установить `readReceiptMode = legacy_reactions` (через API + disable/enable)
2. Открыть Alice и Bob в разных браузерах/incognito
3. Alice пишет сообщение в town-square
4. Bob открывает канал
5. Проверить: на посте Alice появилась реакция `:eyes:` от Bob
6. Alice пишет новое сообщение → Bob перечитывает → `:eyes:` перенеслась
7. Bob пишет свой пост → `:eyes:` не должна ставиться на свой пост

### 3. Hybrid server режим

1. Установить `readReceiptMode = hybrid_server`
2. Зайти под Alice и Bob
3. Alice пишет пост
4. Bob открывает канал
5. Проверить custom indicator `✓ 1` под постом
6. Проверить mirror reaction через API:
   ```bash
   curl -s http://localhost:8065/api/v4/posts/<post_id>/reactions \
     -H "Authorization: Bearer $TOKEN"
   ```

## Известные баги (найдены при E2E тестировании)

1. **P0**: `OnConfigurationChange` не срабатывает при `PATCH /api/v4/config/patch`
   - System config обновляется, но плагин не применяет изменения
   - Только disable/enable заставляет плагин перечитать config
   - Beads: `mattermos-who-read-plugin-b0z`

2. **P0**: `POST /api/v4/plugins/:id/enable` зависает
   - REST API enable зависает (15s+ timeout), mmctl работает
   - Beads: `mattermos-who-read-plugin-3w4`

3. **P0**: `PATCH /api/v4/config/patch` зависает после disable/enable
   - Часть цепочки: сохранение → config patch → re-activate → hang
   - Beads: `mattermos-who-read-plugin-l6a`

4. **P1**: Warning "Unrecognized config permissions tag value: sysconsole_write_*_read"
   - В логах при каждом config patch
   - Возможно связано с settings_schema в plugin.json

## Остановка стенда

```bash
DOCKER_HOST= docker --context rootless compose -f docker-compose.mattermost9.yml down

# Полный сброс данных
DOCKER_HOST= docker --context rootless compose -f docker-compose.mattermost9.yml down -v
```
