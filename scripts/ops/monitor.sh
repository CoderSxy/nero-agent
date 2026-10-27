#!/usr/bin/env bash
# Monitor a manually started service. Does not start/enable it or generate model requests.
set -euo pipefail
seconds=${1:-90}
unit=${2:-nero-agent.service}
[[ $seconds =~ ^[0-9]+$ && $seconds -ge 5 && $seconds -le 300 ]] || { echo 'Duration must be 5..300 seconds' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Run as root so emergency stop is effective' >&2; exit 2; }
stop() {
  trap - ERR INT TERM
  echo "FAILED: $*; stopping $unit" >&2
  systemctl stop "$unit" || echo "ERROR: service stop failed; requesting independent guard" >&2
  if [[ $unit == nero-agent || $unit == nero-agent.service ]]; then
    systemctl --no-block start nero-runtime-emergency.service || {
      echo 'ERROR: emergency unit unavailable; running external guard directly' >&2
      /usr/bin/python3 "$(dirname "$0")/runtime-guard.py" --emergency || echo 'ERROR: emergency stop requires operator inspection' >&2
    }
  fi
  exit 1
}
trap 'stop "monitor interrupted"' INT TERM
trap 'stop "unexpected monitor command failure"' ERR
for ((elapsed=0; elapsed<seconds; elapsed+=5)); do
  state=$(systemctl show "$unit" --value -p ActiveState) || stop 'cannot read service state'
  restarts=$(systemctl show "$unit" --value -p NRestarts) || stop 'cannot read restart count'
  current=$(systemctl show "$unit" --value -p MemoryCurrent) || stop 'cannot read service memory'
  available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo) || stop 'cannot read host memory'
  [[ $state == active && $restarts == 0 ]] || stop "state=$state restarts=$restarts"
  [[ $current =~ ^[0-9]+$ && $available =~ ^[0-9]+$ ]] || stop 'resource metrics unavailable'
  (( current < 480*1024*1024 && available >= 256*1024 )) || stop "memory=$current availableKB=$available"
  printf 'elapsed=%ss memoryBytes=%s availableKB=%s restarts=%s\n' "$elapsed" "$current" "$available" "$restarts"
  systemctl show "$unit" -p IOReadBytes -p IOWriteBytes --no-pager || stop 'cannot read IO accounting'
  sleep 5
done
echo 'Resource observation passed; application and PPT acceptance still required.'
