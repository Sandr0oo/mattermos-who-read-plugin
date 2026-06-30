#!/bin/sh
set -eu

cd /src

COMMAND="${1:-setup}"
TEAM_NAME="test-team"
PLUGIN_ID="$(node -p "require('./plugin.json').id")"
PLUGIN_VERSION="$(node -p "require('./plugin.json').version")"
BUNDLE_NAME="${PLUGIN_ID}-${PLUGIN_VERSION}.tar.gz"
SOCKET_PATH="/var/tmp/mattermost_local.socket"

log() {
    printf "\n==> %s\n" "$*"
}

has_server() {
    if [ -d server ]; then
        return 0
    fi

    node -e "const m = require('./plugin.json'); process.exit(m.server && m.server.executables ? 0 : 1)"
}

wait_mmctl() {
    i=0
    while [ "$i" -lt 120 ]; do
        if [ -S "$SOCKET_PATH" ]; then
            return 0
        fi

        i=$((i + 1))
        sleep 1
    done

    echo "Mattermost local socket not found: $SOCKET_PATH" >&2
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

    log "upload plugin"
    mmctl --local plugin add --force "/src/dist/$BUNDLE_NAME"
    mmctl --local plugin enable "$PLUGIN_ID"
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

    if mmctl --local user search "$username" >/dev/null 2>&1; then
        log "user exists: $username"
        return 0
    fi

    log "create user: $username"
    if [ "$role" = "admin" ]; then
        mmctl --local user create \
            --email "$email" \
            --username "$username" \
            --password "$password" \
            --firstname "$first_name" \
            --lastname "$last_name" \
            --email-verified \
            --disable-welcome-email \
            --system-admin
    else
        mmctl --local user create \
            --email "$email" \
            --username "$username" \
            --password "$password" \
            --firstname "$first_name" \
            --lastname "$last_name" \
            --email-verified \
            --disable-welcome-email
    fi
}

setup_users() {
    wait_mmctl

    ensure_user "admin" "admin@example.com" "AdminPass123!" "Admin" "User" "admin"
    ensure_user "alice" "alice@example.com" "Password123!" "Alice" "Reader"
    ensure_user "bob" "bob@example.com" "Password123!" "Bob" "Reader"

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
    build_plugin
    setup_users
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
