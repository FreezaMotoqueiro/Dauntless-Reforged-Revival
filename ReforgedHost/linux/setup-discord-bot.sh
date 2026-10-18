#!/bin/sh
# Installs (or updates) a Discord bot on this Debian VPS and keeps it running with systemd, next to
# the Dauntless Reforged Revival server. Deploy-DiscordBot.ps1 sends the bot from Windows and runs
# this; it also works by hand. Run as root:
#
#   sh setup-discord-bot.sh --archive <bot.tar.gz> [--name reforged-discord-bot] [--start "<command>"]
#
# The bot runs as its own user (discordbot, no login, no sudo) from /home/discordbot/<name>.
# Node.js (package.json) and Python (requirements.txt, pyproject.toml or a .py file) are found on
# their own. Running it again updates the bot:
#  - its files: new and changed ones are copied; files of the last upload that this one no longer has
#    are removed, unless they changed on the VPS; a file the bot changed on the VPS is kept (its data);
#  - its .env: the upload's settings, with the VPS's value for every setting the upload leaves empty
#    or out, the VPS's DATA_ENCRYPTION_KEY always (the bot's data is encrypted with it), and new
#    settings from .env.example added;
#  - then its dependencies, and a restart.
# Everything inside the bot's folder is done as the bot's user, never as root: a bot that was taken
# over cannot use an update to reach root's files.

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
WORK=$USER_HOME/.deploy-$NAME
UNIT=/etc/systemd/system/$NAME.service
HELPERS=/usr/local/lib/discord-bot-deploy
WRAPPER=$HELPERS/run-with-env.sh
SYSTEMD=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then SYSTEMD=1; fi

# As the bot's user: in its folder (as_bot), or anywhere (bot).
bot() { sudo -H -u "$SERVICE_USER" "$@"; }
as_bot() { sudo -H -u "$SERVICE_USER" sh -c 'cd "$1" && shift && exec "$@"' sh "$APP" "$@"; }

# ---------------------------------------------------------------- the files (root reads only the upload)

step "The bot's files"
STAGE=$(mktemp -d)
cleanup() {
    rm -rf "$STAGE"
    if id -u "$SERVICE_USER" >/dev/null 2>&1; then bot rm -rf "$WORK" 2>/dev/null || true; fi
}
trap cleanup EXIT
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

# ---------------------------------------------------------------- user, then the files as that user

step "User $SERVICE_USER and $APP"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    say "user $SERVICE_USER: already there"
else
    useradd --system --create-home --home-dir "$USER_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
    say "made user $SERVICE_USER (no password, no login)"
fi
chmod 700 "$USER_HOME"
bot mkdir -p "$APP"
if [ "$SYSTEMD" -eq 1 ] && systemctl is-active --quiet "$NAME" 2>/dev/null; then
    systemctl stop "$NAME"
    say "stopped the running bot for the update"
fi
# shellcheck disable=SC2016 # $1 is the inner shell's
bot sh -c 'rm -rf "$1" && mkdir -m 700 "$1" "$1/new"' sh "$WORK"
# Root reads the upload; the bot's user writes it.
tar -C "$SRC" -cf - . | bot tar -xf - -C "$WORK/new"

# Run by the bot's user in its folder, with the upload in $1/new.
# shellcheck disable=SC2016 # expanded by that shell, not this one
UPDATE_FILES='
set -eu
W=$1
S=$W/new
DK=DATA_ENCRYPTION_KEY
for f in "$S/.env" "$S/.env.example"; do [ ! -f "$f" ] || sed -i "s/\r\$//" "$f"; done
had_env=0
if [ -f .env ]; then cp .env "$W/env.vps"; sed -i "s/\r\$//" "$W/env.vps"; had_env=1; fi

# Files: what the last upload had is in .deploy-files ("<sha256>  <path>").
(cd "$S" && find . -type f ! -path ./.env | sed "s|^\./||" | LC_ALL=C sort) > "$W/new.list"
: > "$W/keep.list"
first=1
if [ -f .deploy-files ]; then
    first=0
    while IFS= read -r line; do
        h=${line%%  *}
        f=${line#*  }
        [ -f "$f" ] || continue
        now=$(sha256sum < "$f" | cut -d" " -f1)
        if grep -qxF -- "$f" "$W/new.list"; then
            [ "$now" = "$h" ] || printf "%s\n" "$f" >> "$W/keep.list"
        elif [ "$now" = "$h" ]; then
            rm -f -- "$f"
            echo "removed (no longer in the bot): $f"
        else
            echo "kept (changed on the VPS, no longer in the bot): $f"
        fi
    done < .deploy-files
fi
(cd "$S" && find . -type d ! -path . | sed "s|^\./||") | while IFS= read -r d; do mkdir -p -- "$d"; done
while IFS= read -r f; do
    if grep -qxF -- "$f" "$W/keep.list"; then
        echo "kept the VPS copy (changed on the VPS since the last upload): $f"
        continue
    fi
    cp -p -- "$S/$f" "$f"
done < "$W/new.list"
(cd "$S" && while IFS= read -r f; do printf "%s  %s\n" "$(sha256sum < "$f" | cut -d" " -f1)" "$f"; done < "$W/new.list") > .deploy-files.new
mv .deploy-files.new .deploy-files
if [ "$first" -eq 1 ]; then
    old=$(find . \( -path ./node_modules -o -path ./.venv \) -prune -o -type f -print | sed "s|^\./||" \
        | grep -vxF -f "$W/new.list" | grep -vxE "\.env|\.deploy-files|package-lock\.json" | head -n 20 || true)
    if [ -n "$old" ]; then
        echo "files on the VPS that are not in this upload (an older version, or the bot data); from now on, updates remove old ones by themselves:"
        printf "%s\n" "$old" | sed "s/^/  /"
    fi
fi

# .env
if [ -f "$S/.env" ] || [ "$had_env" -eq 1 ]; then
    base=$S/.env
    keep=
    [ "$had_env" -eq 0 ] || keep=$W/env.vps
    if [ ! -f "$base" ]; then base=$W/env.vps; keep=; echo "kept the .env already on the VPS (the upload has none)"; fi
    set -- "$base"
    [ -z "$keep" ] || set -- "$keep" "$base"
    [ ! -f "$S/.env.example" ] || set -- "$@" "$S/.env.example"
    awk -v KEEP="$keep" -v BASE="$base" -v EX="$S/.env.example" -v PROTECT="$DK" "$MERGE_ENV" "$@" > .env.new
    mv .env.new .env
elif [ -f "$S/.env.example" ]; then
    cp "$S/.env.example" .env
    configured=no
fi
if [ -f .env ]; then
    chmod 600 .env
    if grep -qs "^$DK=" .env .env.example || grep -rqs "$DK" src 2>/dev/null; then
        v=$(sed -n "s/^$DK=//p" .env | tail -n 1 | tr -d "\"'"'"' \t")
        if [ "$(printf "%s" "$v" | base64 -d 2>/dev/null | wc -c)" -ne 32 ]; then
            new=$(head -c 32 /dev/urandom | base64 | tr -d "\n")
            if grep -q "^$DK=" .env; then
                awk -v k="$DK" -v v="$new" "index(\$0, k \"=\") == 1 { print k \"=\" v; next } { print }" .env > .env.new
                mv .env.new .env
                chmod 600 .env
            else
                printf "%s=%s\n" "$DK" "$new" >> .env
            fi
            echo "$DK was missing or not a Base64 key of 32 bytes: made a new one. Keep a copy of it somewhere safe (grep $DK $PWD/.env): without it the data the bot encrypts is lost"
        fi
    fi
    empty=$(grep -E "^[A-Za-z_][A-Za-z0-9_]*=[[:space:]]*(\"\"|'"''"')?[[:space:]]*\$" .env | cut -d= -f1 | tr "\n" " " || true)
    [ -z "$empty" ] || echo "still empty in .env: $empty"
fi
[ "${configured:-yes}" = yes ] || exit 10
'

# Merges .env files: KEEP (the VPS's, optional), BASE (the upload's, or the VPS's), EX (.env.example,
# optional). Prints the result; says on stderr what it kept and added, never a value.
# shellcheck disable=SC2016 # awk's own variables
MERGE_ENV='
function keyof(l,   k) {
    sub(/^[ \t]*export[ \t]+/, "", l)
    if (l !~ /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) return ""
    k = l; sub(/=.*/, "", k); gsub(/[ \t]/, "", k); return k
}
function valof(l,   v) { v = l; sub(/^[^=]*=/, "", v); gsub(/^[ \t]+|[ \t]+$/, "", v); return v }
function isempty(v) { return v == "" || v == "\"\"" || v == "\047\047" }
FILENAME == KEEP { k = keyof($0); if (k != "" && !isempty(valof($0))) { if (!(k in keep)) order[++nk] = k; keep[k] = $0 } next }
FILENAME == BASE {
    k = keyof($0)
    if (k != "") {
        have[k] = 1
        if (k in keep) {
            if (isempty(valof($0))) { print keep[k]; print "kept the VPS value of " k " (empty in the upload)" > "/dev/stderr"; next }
            if (k == PROTECT && valof($0) != valof(keep[k])) { print keep[k]; print "kept the VPS " k ": the upload has another one, and the bot data is encrypted with the VPS one (to change it, edit .env on the VPS)" > "/dev/stderr"; next }
        }
    }
    print; next
}
FILENAME == EX { k = keyof($0); if (k != "") { if (!(k in exk)) exorder[++ne] = k; exk[k] = $0 } next }
END {
    head = 0
    for (i = 1; i <= nk; i++) { k = order[i]; if (k in have) continue
        if (!head) { print ""; print "# Kept from the VPS by setup-discord-bot.sh"; head = 1 }
        print keep[k]; have[k] = 1; print "kept the VPS value of " k " (not in the upload)" > "/dev/stderr" }
    head = 0
    for (i = 1; i <= ne; i++) { k = exorder[i]; if (k in have) continue
        if (!head) { print ""; print "# Added from .env.example by setup-discord-bot.sh"; head = 1 }
        print exk[k]; have[k] = 1; print "new setting from .env.example: " k " (check its value)" > "/dev/stderr" }
}
'

configured=yes
rc=0
as_bot env MERGE_ENV="$MERGE_ENV" sh -c "$UPDATE_FILES" sh "$WORK" || rc=$?
case "$rc" in
    0) ;;
    10) configured=no ;;
    *) die "updating the bot's files failed (exit $rc)" ;;
esac
say "files in place"

# ---------------------------------------------------------------- dependencies and start command

json_field() {
    # package.json's scripts.<name> or main, read as the bot's user; control characters dropped
    bot node -e 'const p = require(process.argv[1]); const k = process.argv[2]; const v = k === "main" ? p.main : (p.scripts || {})[k]; if (typeof v === "string" && v.trim()) process.stdout.write(v);' "$APP/package.json" "$1" | tr -d '\000-\037\177'
}

EXEC=
if [ "$KIND" = node ]; then
    step "Dependencies (npm)"
    # npm ci only with the bot's own lock file: one npm install made on the VPS for an older version
    # would not match a newer package.json (npm install brings it up to date instead).
    if [ -f "$SRC/package-lock.json" ]; then as_bot npm ci --no-audit --no-fund; else as_bot npm install --no-audit --no-fund; fi
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
            # A path, nothing else: it goes into the unit file.
            case "$main" in *[!A-Za-z0-9._/@+-]*) main= ;; esac
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

# The .env: read by the bot itself (dotenv, node --env-file, python-dotenv), or else by a small
# wrapper running as the bot's user. Never systemd's EnvironmentFile, which reads it as root.
PREFIX=
if ! as_bot grep -rqsE --exclude-dir=node_modules --exclude-dir=.venv 'dotenv|env-file|loadEnvFile' . ; then
    mkdir -p "$HELPERS"
    cat > "$WRAPPER" <<'EOF'
#!/bin/sh
# Written by setup-discord-bot.sh: reads the bot's .env (KEY=VALUE lines) as the bot's own user,
# then starts the bot with those settings in its environment.
cr=$(printf '\r')
if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%"$cr"}
        case "$line" in ''|'#'*) continue ;; esac
        line=${line#export }
        key=${line%%=*}
        [ "$key" != "$line" ] || continue
        case "$key" in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
        value=${line#*=}
        case "$value" in
            \"*\") value=${value#\"}; value=${value%\"} ;;
            \'*\') value=${value#\'}; value=${value%\'} ;;
        esac
        export "$key=$value"
    done < .env
fi
exec "$@"
EOF
    chmod 755 "$WRAPPER"
    PREFIX="/bin/sh $WRAPPER "
    say "settings: .env passed on by $WRAPPER (the bot does not read it itself)"
fi

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
ExecStart=$PREFIX$EXEC
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
say "written: $UNIT"

if [ "$SYSTEMD" -eq 0 ]; then
    step "Not started: systemd is not running here"
    say "Start it by hand: cd $APP && sudo -u $SERVICE_USER $PREFIX$EXEC"
    exit 0
fi
systemctl daemon-reload
systemctl enable "$NAME" >/dev/null 2>&1
if [ "$configured" = no ]; then
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
            # shellcheck disable=SC2086 # PREFIX is a command and its argument, or nothing
            as_bot $PREFIX npm run "$s" || warn "npm run $s failed: the bot still starts; run it again later (cd $APP && sudo -u $SERVICE_USER ${PREFIX}npm run $s)"
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
