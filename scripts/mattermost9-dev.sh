#!/bin/sh
set -eu

cd /src

COMMAND="${1:-setup}"
TEAM_NAME="test-team"
PLUGIN_ID="$(node -p "require('./plugin.json').id")"
PLUGIN_VERSION="$(node -p "require('./plugin.json').version")"
BUNDLE_NAME="${PLUGIN_ID}-${PLUGIN_VERSION}.tar.gz"
SOCKET_PATH="/var/tmp/mattermost_local.socket"
MMCTL_WAIT_SECONDS="${MMCTL_WAIT_SECONDS:-180}"
PLUGIN_ENABLE_TIMEOUT_SECONDS="${PLUGIN_ENABLE_TIMEOUT_SECONDS:-60}"

log() {
    printf "\n==> %s\n" "$*"
}

run_mmctl() {
    action="$1"
    shift

    if ! output="$(mmctl --local "$@" 2>&1)"; then
        echo "Mattermost mmctl command failed: $action" >&2
        echo "Command: mmctl --local $*" >&2
        echo "Output:" >&2
        printf '%s\n' "$output" >&2
        exit 1
    fi

    if [ -n "$output" ]; then
        printf '%s\n' "$output"
    fi
}

enable_plugin_with_timeout() {
    command="timeout $PLUGIN_ENABLE_TIMEOUT_SECONDS mmctl --local plugin enable $PLUGIN_ID"

    set +e
    output="$(timeout "$PLUGIN_ENABLE_TIMEOUT_SECONDS" mmctl --local plugin enable "$PLUGIN_ID" 2>&1)"
    status="$?"
    set -e

    if [ "$status" -eq 0 ]; then
        if [ -n "$output" ]; then
            printf '%s\n' "$output"
        fi
        return 0
    fi

    echo "Warning: plugin enable command returned status $status; continuing to verify plugin state." >&2
    echo "Command: $command" >&2
    echo "Output:" >&2
    if [ -n "$output" ]; then
        printf '%s\n' "$output" >&2
    else
        echo "<empty>" >&2
    fi

    return 0
}

has_server() {
    if [ -d server ]; then
        return 0
    fi

    node -e "const m = require('./plugin.json'); process.exit(m.server && m.server.executables ? 0 : 1)"
}

wait_mmctl() {
    i=0
    last_output="Mattermost local socket not found yet: $SOCKET_PATH"

    while [ "$i" -lt "$MMCTL_WAIT_SECONDS" ]; do
        if [ -S "$SOCKET_PATH" ]; then
            if output="$(mmctl --local system status 2>&1)"; then
                return 0
            fi

            last_output="$output"
        else
            last_output="Mattermost local socket not found yet: $SOCKET_PATH"
        fi

        i=$((i + 1))
        sleep 1
    done

    echo "Mattermost is not ready: mmctl --local system status did not succeed after ${MMCTL_WAIT_SECONDS}s." >&2
    echo "Last output:" >&2
    printf '%s\n' "$last_output" >&2
    exit 1
}

validate_archive() {
    archive="/src/dist/$BUNDLE_NAME"

    if [ ! -s "$archive" ]; then
        echo "Plugin archive is missing or empty: $archive" >&2
        echo "Run setup/deploy so build_plugin and pack_plugin create dist/$BUNDLE_NAME before upload." >&2
        exit 1
    fi

    if ! tar_output="$(tar -tzf "$archive" 2>&1)"; then
        echo "Plugin archive is not a valid gzip tar: $archive" >&2
        echo "tar -tzf output:" >&2
        printf '%s\n' "$tar_output" >&2
        exit 1
    fi
}

assert_plugin_enabled() {
    if ! output="$(mmctl --local plugin list 2>&1)"; then
        echo "Could not verify enabled plugin: mmctl --local plugin list failed." >&2
        echo "Output:" >&2
        printf '%s\n' "$output" >&2
        exit 1
    fi

    if printf '%s\n' "$output" | awk -v plugin_id="$PLUGIN_ID" '
        /^Listing enabled plugins/ { enabled = 1; next }
        /^Listing / { enabled = 0 }
        enabled && index($0, plugin_id) > 0 { found = 1 }
        END { exit found ? 0 : 1 }
    '; then
        log "plugin enabled: $PLUGIN_ID"
        return 0
    fi

    echo "Plugin $PLUGIN_ID was uploaded/enabled, but is not listed in the enabled plugins section." >&2
    echo "mmctl --local plugin list output:" >&2
    printf '%s\n' "$output" >&2
    exit 1
}

user_output_has_exact_user() {
    username="$1"
    email="$2"

    awk -v username="$username" -v email="$email" '
        {
            line = $0
            gsub(/[][{}()",:;]/, " ", line)
            split(line, fields, /[[:space:]]+/)

            for (i in fields) {
                if (fields[i] == username) {
                    found_username = 1
                }
                if (fields[i] == email) {
                    found_email = 1
                }
            }
        }
        END { exit (found_username && found_email) ? 0 : 1 }
    '
}

search_user_output() {
    email="$1"

    mmctl --local user search "$email" 2>&1 || true
}

assert_user_exists() {
    username="$1"
    email="$2"
    output="$(search_user_output "$email")"

    if printf '%s\n' "$output" | user_output_has_exact_user "$username" "$email"; then
        log "user found: $username <$email>"
        return 0
    fi

    echo "Expected user was not found by exact username/email match: $username <$email>" >&2
    echo "mmctl --local user search $email output:" >&2
    printf '%s\n' "$output" >&2
    exit 1
}

build_server() {
    if ! has_server; then
        return 0
    fi

    if [ ! -d server ]; then
        echo "plugin.json declares server.executables, but server/ is missing" >&2
        exit 1
    fi

    log "build server"
    mkdir -p server/dist
    (cd server && env CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o dist/plugin-linux-amd64)
    (cd server && env CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o dist/plugin-linux-arm64)
    (cd server && env CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -o dist/plugin-darwin-amd64)
    (cd server && env CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -o dist/plugin-darwin-arm64)
    (cd server && env CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -o dist/plugin-windows-amd64.exe)
}

build_plugin() {
    log "generate manifest"
    go run ./build/manifest apply

    build_server

    if [ "${INSTALL_DEPENDENCIES:-0}" = "1" ] || [ ! -d webapp/node_modules ]; then
        log "npm install"
        (cd webapp && npm install)
    fi

    log "build webapp"
    (cd webapp && npm run build)
}

pack_plugin() {
    log "pack plugin ${PLUGIN_ID} ${PLUGIN_VERSION}"
    rm -rf "dist/$PLUGIN_ID" "dist/$BUNDLE_NAME"
    mkdir -p "dist/$PLUGIN_ID/webapp"

    go run ./build/manifest dist

    [ -d assets ] && cp -R assets "dist/$PLUGIN_ID/"
    [ -d public ] && cp -R public "dist/$PLUGIN_ID/"
    if has_server; then
        if [ ! -d server/dist ]; then
            echo "server/dist not found; run deploy/setup to build server executables" >&2
            exit 1
        fi

        mkdir -p "dist/$PLUGIN_ID/server"
        cp -R server/dist "dist/$PLUGIN_ID/server/"
    fi
    cp -R webapp/dist "dist/$PLUGIN_ID/webapp/"

    (cd dist && tar -czf "$BUNDLE_NAME" "$PLUGIN_ID")
}

deploy_archive() {
    wait_mmctl
    validate_archive

    log "upload plugin"
    run_mmctl "upload plugin archive $BUNDLE_NAME" plugin add --force "/src/dist/$BUNDLE_NAME"

    log "enable plugin $PLUGIN_ID"
    enable_plugin_with_timeout

    log "verify plugin enabled"
    assert_plugin_enabled
}

deploy() {
    build_plugin
    pack_plugin
    deploy_archive
    list_plugins
}

ensure_user() {
    username="$1"
    email="$2"
    password="$3"
    first_name="$4"
    last_name="$5"
    role="${6:-user}"

    search_output="$(search_user_output "$email")"
    if printf '%s\n' "$search_output" | user_output_has_exact_user "$username" "$email"; then
        log "user exists: $username <$email>"
    else
        log "create user: $username <$email>"
        if [ "$role" = "admin" ]; then
            run_mmctl "create admin user $username" user create \
                --email "$email" \
                --username "$username" \
                --password "$password" \
                --firstname "$first_name" \
                --lastname "$last_name" \
                --email-verified \
                --disable-welcome-email \
                --system-admin
        else
            run_mmctl "create user $username" user create \
                --email "$email" \
                --username "$username" \
                --password "$password" \
                --firstname "$first_name" \
                --lastname "$last_name" \
                --email-verified \
                --disable-welcome-email
        fi
    fi

    run_mmctl "activate user $username" user activate "$username"
    run_mmctl "verify user email $email" user verify "$email"
    run_mmctl "reset dev password for $username" user change-password "$username" --password "$password"

    if [ "$role" = "admin" ]; then
        run_mmctl "grant system_admin to $username" roles system_admin "$username"
    fi

    assert_user_exists "$username" "$email"
}

setup_users() {
    wait_mmctl

    ensure_user "admin" "admin@example.com" "AdminPass123!" "Admin" "User" "admin"
    ensure_user "alice" "alice@example.com" "Password123!" "Alice" "Reader"
    ensure_user "bob" "bob@example.com" "Password123!" "Bob" "Reader"

    assert_user_exists "admin" "admin@example.com"
    assert_user_exists "alice" "alice@example.com"
    assert_user_exists "bob" "bob@example.com"

    if mmctl --local team list 2>/dev/null | grep -qx "$TEAM_NAME"; then
        log "team exists: $TEAM_NAME"
    else
        log "create team: $TEAM_NAME"
        mmctl --local team create --name "$TEAM_NAME" --display-name "Test Team" --email "admin@example.com"
    fi

    log "add users to $TEAM_NAME"
    mmctl --local team users add "$TEAM_NAME" admin alice bob
}

list_plugins() {
    wait_mmctl

    log "plugin list"
    mmctl --local plugin list
}

setup() {
    setup_users
    build_plugin
    pack_plugin
    deploy_archive
    list_plugins

    cat <<EOF

Mattermost: http://localhost:8065
admin@example.com / AdminPass123!
alice@example.com / Password123!
bob@example.com / Password123!
EOF
}

case "$COMMAND" in
    setup) setup ;;
    deploy) deploy ;;
    list) list_plugins ;;
    *)
        echo "Usage: mattermost9-dev.sh [setup|deploy|list]" >&2
        exit 2
        ;;
esac
