---
name: dev-processes
description: Use before starting, reusing, restarting or stopping the local dev stack (`pnpm dev` and the server, worker, collab and web processes it runs) in a breatic worktree; before starting any other process that must outlive the command that starts it; before generating CPU or I/O load to reproduce a problem; before killing a process; and before writing a shell loop or script that runs commands held in variables.
---

# Dev processes

Several worktrees of this repository run their own dev stack on the same machine at the same time. The commands below keep each stack owned by the worktree that started it, and keep experiments from outliving the command that started them.

## Starting the stack

**Start the stack with `pnpm dev` from the worktree root; that worktree's `.env` already gives it its own ports, databases and `REDIS_KEY_PREFIX`.** Each worktree's `.env` is shifted from the defaults as the table in [`.env.dev`](../../../.env.dev) describes, so a busy 3000 or 8000 belongs to another worktree and says nothing about yours. Read the ports from the startup output or `logs/`, never from `.env`.

Check: am I about to give up on starting because a port is taken? Start it and read the error first.

**Do not build a second environment by overriding ports or prefixes by hand.** Redis pub/sub channels ignore the DB number and only `REDIS_KEY_PREFIX` separates them, so a hand-made stack whose prefix did not take effect publishes into another worktree's channels.

### Reuse a running stack

**Each worktree runs at most one stack; look for yours before starting one.**

```sh
ps -eo pid,etime,command | grep "[/]<worktree-dir>/" | grep "turbo.*run dev"
```

Any output means the stack is already up: use it. Every extra stack adds its whole process tree to a machine the other worktrees share.

Check: am I about to type `pnpm dev`? Run the lookup first.

### Start it detached

**Never start the stack, or any process that must outlive the command, with the Bash tool's `run_in_background`.** When that background task is stopped, the signal goes to its whole process group and takes turbo, vite and every `tsx watch` with it.

macOS has no `setsid` command; start a new session through Python instead:

```sh
python3 -c "import subprocess; subprocess.Popen(['pnpm','dev'], cwd='<worktree>', stdout=open('<log>','w'), stderr=subprocess.STDOUT, start_new_session=True)"
```

**Then confirm it detached: its process group must differ from the shell's.** A port answering is not proof.

```sh
ps -o pgid= -p <service-pid>
ps -o pgid= -p $$
```

`nohup` and `disown` only block `SIGHUP`, so a process started with them still dies with its group.

## Whose process is it

**Identify a process by the worktree path in its command line, never by its port.**

```sh
lsof -nP -iTCP:<port> -sTCP:LISTEN -t
ps -o pid,etime,command -p <pid>
```

A process whose command line holds another worktree's path is not yours: do not kill it, do not reuse it, and do not point your frontend at its backend, which would write your test data into that worktree's database. On `EADDRINUSE`, check the holder this way before doing anything; a `pnpm dev`, `tsx watch` or `vite` that has been up for a long time is someone's working session.

## Stopping processes

**Kill only the PIDs you recorded when you started them; never `pkill -f`.** A name pattern also matches every other worktree's identical command line.

**Kill several PIDs with `xargs`, one per call, and keep stderr visible.**

```sh
printf '%s\n' $pids | xargs -n1 kill   # right
kill $pids 2>/dev/null                 # wrong in zsh: one argument, and the failure is hidden
```

## Restarting after changes

**Source edits in any package need no restart.** Root `pnpm dev` runs `tsup --watch` for the library packages and `tsx watch` for server, worker and collab; edits to library source have restarted all three services in every observed case, and web hot-reloads. How `tsx watch` sees the rebuilt library `dist` is not confirmed, so after upgrading tsx, tsup or pnpm check the process age once more instead of trusting this.

**Restart by hand only in these cases:**

| Case | Why |
|---|---|
| A service crashed or stopped answering | Nothing restarts it |
| `.env`, `config/*.yaml` or a `package.json` dependency changed | Not watched |
| A build config changed (tsup, vite, tsconfig) | The running watchers keep the old config |
| Behaviour contradicts the code and `ps -o etime -p <pid>` is older than your last edit | The process never reloaded |

Check: before blaming a stale process, does its age show it predates the edit?

## Generating load

**Generate load only with commands that end by themselves, and clean up a long-lived process in a separate command.**

```sh
node -e "const t=Date.now();while(Date.now()-t<40000);" &   # exits after 40 s
timeout 60 yes > /dev/null &                                 # needs GNU coreutils on macOS
(while :; do :; done) & ...; kill %1                         # wrong: lives forever if the shell goes away first
```

Only a command timeout signals the whole group; when the shell ends any other way, a child of `&` is adopted by init (PPID 1) and keeps a core busy, which also makes unrelated timing tests fail.

Check: if nobody kills it, does it stop?

## Commands held in variables (zsh)

**zsh does not word-split unquoted variables, so a command stored in a variable runs as one word.**

```zsh
for c in "turbo build" "turbo test"; do pnpm $c; done   # wrong: pnpm gets "turbo build", exits 254
run() { local name=$1; shift; "$@"; echo "$name => $?"; }
run build pnpm turbo build                               # right: each word is its own argument
```

`${=c}` splits explicitly when a variable is unavoidable. The same applies to `set -- $spec` and to `kill $pids`.

Check: does this loop or script put a command and its arguments into one variable?
