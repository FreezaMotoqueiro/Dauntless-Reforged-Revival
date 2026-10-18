#!/bin/sh
# Installs (or updates) a Discord bot on this Debian VPS and keeps it running with systemd, next to
# the Dauntless Reforged Revival server. Deploy-DiscordBot.ps1 sends the bot from Windows and runs
# this; it also works by hand. Run as root:
#
#   sh setup-discord-bot.sh --archive <bot.tar.gz> [--name reforged-discord-bot] [--start "<command>"]
#
# The bot runs as its own user (discordbot, no login, no sudo) from /home/discordbot/<name>.
# Node.js (package.json) and Python (requirements.txt, pyproject.toml or a .py file) are found on
# their own. Running it again updates the files, keeps the .env already on the VPS when the upload
# has none, reinstalls the dependencies and restarts the bot.

set -eu

NAME=reforged-discord-bot
SERVICE_USER=discordbot
ARCHIVE=
START=

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Installs (or updates) a Discord bot and runs it with systemd. Run as root:
  sh setup-discord-bot.sh --archive <bot.tar.gz> [--name <name>] [--start "<command>"] [--user <user>]

  --archive   the bot's folder as a .tar.gz (Deploy-DiscordBot.ps1 makes it)
  --name      the service and folder name (default reforged-discord-bot)
  --start     how to start the bot, when it is not found on its own (example: "node dist/index.js")
  --user      the user it runs as (default discordbot)
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --archive) [ $# -ge 2 ] || die "--archive needs a file"; ARCHIVE=$2; shift 2 ;;
        --name) [ $# -ge 2 ] || die "--name needs a value"; NAME=$2; shift 2 ;;
        --start) [ $# -ge 2 ] || die "--start needs a command"; START=$2; shift 2 ;;
        --user) [ $# -ge 2 ] || die "--user needs a value"; SERVICE_USER=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo sh $0 ...)"
[ -n "$ARCHIVE" ] || die "--archive <bot.tar.gz> is needed (see --help)"
[ -f "$ARCHIVE" ] || die "--archive $ARCHIVE: no such file"
printf '%s' "$NAME" | grep -Eq '^[a-z0-9][a-z0-9-]{0,47}$' || die "--name must be lowercase letters, digits and dashes (got $NAME)"
printf '%s' "$SERVICE_USER" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "--user must be a plain user name (got $SERVICE_USER)"
[ "$SERVICE_USER" != root ] || die "the bot must not run as root"
case "$START" in *'"'*|*"
"*) die "--start must be one line without double quotes" ;; esac

USER_HOME=/home/$SERVICE_USER
APP=$USER_HOME/$NAME
UNIT=/etc/systemd/system/$NAME.service
SYSTEMD=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then SYSTEMD=1; fi

as_bot() {
    sudo -H -u "$SERVICE_USER" sh -c 'cd "$1" && shift && exec "$@"' sh "$APP" "$@"
}

# ---------------------------------------------------------------- the files

step "The bot's files"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner
# The archive holds the bot's folder: use what is inside it.
SRC=$STAGE
entries=$(ls -A "$SRC")
if [ "$(printf '%s\n' "$entries" | wc -l)" -eq 1 ] && [ -d "$SRC/$entries" ]; then SRC=$SRC/$entries; fi
[ -n "$(ls -A "$SRC")" ] || die "the archive is empty"

KIND=
if [ -f "$SRC/package.json" ]; then
    KIND=node
elif [ -f "$SRC/requirements.txt" ] || [ -f "$SRC/pyproject.toml" ] || ls "$SRC"/*.py >/dev/null 2>&1; then
    KIND=python
fi
[ -n "$KIND" ] || [ -n "$START" ] || die "no package.json, requirements.txt, pyproject.toml or .py file in the bot's folder: pass --start \"<command>\""
say "kind: ${KIND:-custom (--start)}"

# ---------------------------------------------------------------- packages

step "Packages"
export DEBIAN_FRONTEND=noninteractive
need=""
command -v sudo >/dev/null 2>&1 || need="$need sudo"
if [ "$KIND" = node ] && ! command -v node >/dev/null 2>&1; then need="$need nodejs npm"; fi
if [ "$KIND" = node ] && ! command -v npm >/dev/null 2>&1; then need="$need npm"; fi
if [ "$KIND" = python ]; then
    command -v python3 >/dev/null 2>&1 || need="$need python3"
    python3 -c 'import ensurepip, venv' >/dev/null 2>&1 || need="$need python3-venv"
fi
if [ -n "$need" ]; then
    apt-get update -q
    # shellcheck disable=SC2086 # a list of package names
    apt-get install -y --no-install-recommends $need
else
    say "already installed"
fi
[ "$KIND" != node ] || say "node $(node --version), npm $(npm --version)"
[ "$KIND" != python ] || say "$(python3 --version)"

# ---------------------------------------------------------------- user and folder

step "User $SERVICE_USER and $APP"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    say "user $SERVICE_USER: already there"
else
    useradd --system --create-home --home-dir "$USER_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
    say "made user $SERVICE_USER (no password, no login)"
fi
mkdir -p "$APP"
if [ "$SYSTEMD" -eq 1 ] && systemctl is-active --quiet "$NAME" 2>/dev/null; then
    systemctl stop "$NAME"
    say "stopped the running bot for the update"
fi
had_env=0
[ -f "$APP/.env" ] && had_env=1
# Over what is there: files the bot wrote itself (a database, its data) stay; files in the upload
# replace theirs.
cp -a "$SRC/." "$APP/"
if [ ! -f "$SRC/.env" ] && [ "$had_env" -eq 1 ]; then say "kept the .env already on the VPS"; fi
chown -R "$SERVICE_USER:" "$USER_HOME"
chmod 700 "$USER_HOME"
if [ -f "$APP/.env" ]; then
    # Written on Windows: a CR at the end of each line would end up inside the token.
    sed -i 's/\r$//' "$APP/.env"
    chmod 600 "$APP/.env"
fi
say "files in place"

# ---------------------------------------------------------------- dependencies and start command

json_field() {
    # package.json's scripts.<name> or main, or nothing
    node -e 'const p = require(process.argv[1]); const k = process.argv[2]; const v = k === "main" ? p.main : (p.scripts || {})[k]; if (typeof v === "string" && v.trim()) process.stdout.write(v);' "$APP/package.json" "$1"
}

has_dependency() {
    # $1: a word to look for in the dependency lists (dotenv, python-dotenv)
    case "$KIND" in
        node) node -e 'const p = require(process.argv[1]); const d = { ...(p.dependencies || {}), ...(p.devDependencies || {}) }; process.exit(process.argv[2] in d ? 0 : 1);' "$APP/package.json" "$1" ;;
        python) cat "$APP/requirements.txt" "$APP/pyproject.toml" 2>/dev/null | grep -Eiq "(^|[^a-z0-9_-])$1([^a-z0-9_-]|$)" ;;
        *) return 1 ;;
    esac
}

EXEC=
if [ "$KIND" = node ]; then
    step "Dependencies (npm)"
    if [ -f "$APP/package-lock.json" ]; then as_bot npm ci --no-audit --no-fund; else as_bot npm install --no-audit --no-fund; fi
    if [ -n "$(json_field build)" ]; then
        say "building (npm run build)"
        as_bot npm run build
    fi
    if [ -z "$START" ]; then
        if [ -n "$(json_field start)" ]; then
            EXEC="$(command -v npm) start"
            say "start: npm start ($(json_field start))"
        else
            main=$(json_field main)
            for f in "$main" index.js bot.js src/index.js src/bot.js dist/index.js; do
                if [ -n "$f" ] && [ -f "$APP/$f" ]; then EXEC="$(command -v node) $f"; break; fi
            done
            [ -n "$EXEC" ] || die "no start script, main or index.js in package.json's folder: pass --start \"node <file>\""
            say "start: $EXEC"
        fi
    fi
elif [ "$KIND" = python ]; then
    step "Dependencies (Python, in $APP/.venv)"
    [ -x "$APP/.venv/bin/python" ] || as_bot python3 -m venv .venv
    as_bot .venv/bin/python -m pip install --quiet --upgrade pip
    if [ -f "$APP/requirements.txt" ]; then
        as_bot .venv/bin/python -m pip install --quiet -r requirements.txt
    elif [ -f "$APP/pyproject.toml" ]; then
        as_bot .venv/bin/python -m pip install --quiet .
    fi
    say "installed"
    if [ -z "$START" ]; then
        for f in bot.py main.py app.py run.py src/bot.py src/main.py; do
            if [ -f "$APP/$f" ]; then EXEC="$APP/.venv/bin/python -u $f"; break; fi
        done
        [ -n "$EXEC" ] || die "no bot.py, main.py, app.py or run.py: pass --start \".venv/bin/python <file>\""
        say "start: $EXEC"
    fi
fi
if [ -n "$START" ]; then
    # systemd expands % and $ itself: double them so the command runs as written.
    EXEC="/bin/sh -c \"exec $(printf '%s' "$START" | sed -e 's/%/%%/g' -e 's/\$/$$/g')\""
    say "start: $START"
fi

# The bot reads its .env itself when it uses dotenv; otherwise systemd passes it on.
ENVFILE=
if ! has_dependency dotenv && ! has_dependency python-dotenv; then ENVFILE="EnvironmentFile=-$APP/.env"; fi
# npm's scripts call node by name, and systemd's PATH is short: node's own folder goes first.
SERVICE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if command -v node >/dev/null 2>&1; then SERVICE_PATH=$(dirname "$(command -v node)"):$SERVICE_PATH; fi

# ---------------------------------------------------------------- the service

step "Service $NAME (systemd)"
cat > "$UNIT" <<EOF
# Written by setup-discord-bot.sh. Logs: journalctl -u $NAME -f
[Unit]
Description=Discord bot $NAME
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP
Environment=PATH=$SERVICE_PATH
Environment=NODE_ENV=production
Environment=PYTHONUNBUFFERED=1
$ENVFILE
ExecStart=$EXEC
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
say "written: $UNIT"

if [ ! -f "$APP/.env" ] && [ -f "$APP/.env.example" ]; then
    cp "$APP/.env.example" "$APP/.env"
    chown "$SERVICE_USER:" "$APP/.env"
    chmod 600 "$APP/.env"
    NOT_CONFIGURED=1
else
    NOT_CONFIGURED=0
fi

if [ "$SYSTEMD" -eq 0 ]; then
    step "Not started: systemd is not running here"
    say "Start it by hand: cd $APP && sudo -u $SERVICE_USER $EXEC"
    exit 0
fi
systemctl daemon-reload
systemctl enable "$NAME" >/dev/null 2>&1
if [ "$NOT_CONFIGURED" -eq 1 ]; then
    step "Fill in the bot's settings, then start it"
    say "The upload had no .env, so it was made from .env.example. Put the bot token (and the rest) in it:"
    say "  nano $APP/.env"
    say "  systemctl restart $NAME"
    exit 0
fi
if [ "$KIND" = node ]; then
    # Slash commands: registered with Discord by a script of the bot's own, when it has one.
    for s in deploy-commands register-commands deploy:commands commands:deploy register; do
        if [ -n "$(json_field "$s")" ]; then
            say "registering the slash commands (npm run $s)"
            as_bot npm run "$s" || warn "npm run $s failed: the bot still starts; run it again later (cd $APP && sudo -u $SERVICE_USER npm run $s)"
            break
        fi
    done
fi
systemctl restart "$NAME"
say "started; checking it stays up..."
sleep 8
if systemctl is-active --quiet "$NAME"; then
    say "running"
else
    warn "the bot stopped right after starting: its last lines are below (journalctl -u $NAME -n 50)"
fi
journalctl -u "$NAME" -n 15 --no-pager || true

step "Done"
say "Logs:     journalctl -u $NAME -f"
say "Restart:  systemctl restart $NAME"
say "Stop:     systemctl stop $NAME   (and systemctl disable $NAME to keep it off after a reboot)"
say "Settings: nano $APP/.env   (then restart)"
