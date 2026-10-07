#!/bin/bash
# Run a command line in its own session, detached from this shell, so it
# outlives the agent session that started it. Output to LOG.
#   scripts/hifi/detach.sh LOG 'cmd; cmd; ...'
log=$1; shift
cd "$(dirname "$0")/../.." || exit 1
nohup python3 -c 'import os,sys; os.setsid(); os.execvp("bash",["bash","-c",sys.argv[1]])' "$*" > "$log" 2>&1 < /dev/null &
echo "detached pid $! -> $log"
