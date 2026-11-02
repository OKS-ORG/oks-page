#!/usr/bin/env bash
# S8: runs the site image under memory limits and measures it: time to the first page, memory after start and after
# 200 and 3,000 requests, and whether the container was killed for using too much memory.
# Usage: scripts/hosting-baseline.sh IMAGE DATABASE_FILE
# Prints a Markdown table, and also writes it to $GITHUB_STEP_SUMMARY when that is set. Exit code 1 when a case failed.
set -u
IMAGE="$1"
DATA="$(dirname "$2")"
NAME=oks-baseline
URL=http://127.0.0.1:3000
ROWS=""
FAILED=0

mem_mb() { # the memory in use now, in MB, as Docker reports it
  docker stats --no-stream --format '{{.MemUsage}}' "$NAME" | sed 's/ \/.*//' | awk '
    /GiB/ { sub(/GiB/, ""); printf "%d", $1 * 1024; next }
    /MiB/ { sub(/MiB/, ""); printf "%d", $1; next }
    /KiB/ { sub(/KiB/, ""); printf "%d", $1 / 1024; next }
    { printf "0" }'
}

burst() { # ROUNDS: each round sends 10 requests at once; prints how many did not answer 200
  local rounds="$1" bad=0 out
  for _ in $(seq 1 "$rounds"); do
    out=$(for _ in 1 2 3 4 5 6 7 8 9 10; do
      (c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL/blog/post-$((RANDOM % 50))"); [ "$c" = "200" ] || echo bad) &
    done; wait)
    bad=$((bad + $(printf '%s' "$out" | grep -c bad)))
  done
  echo "$bad"
}

run_case() { # LIMIT NODE_OPTIONS LABEL
  local limit="$1" heap="$2" label="$3" started code start_ms after_start after200 after3000 failed oom more
  docker rm -f "$NAME" >/dev/null 2>&1
  started=$(date +%s%3N)
  if [ -n "$heap" ]; then
    docker run -d --name "$NAME" --memory "$limit" --memory-swap "$limit" -p 3000:3000 \
      -v "$DATA:/data" -e NODE_OPTIONS="$heap" "$IMAGE" >/dev/null
  else
    docker run -d --name "$NAME" --memory "$limit" --memory-swap "$limit" -p 3000:3000 \
      -v "$DATA:/data" "$IMAGE" >/dev/null
  fi
  code=000
  for _ in $(seq 1 150); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$URL/" || true)
    [ "$code" = "200" ] && break
    sleep 0.2
  done
  start_ms=$(($(date +%s%3N) - started))
  if [ "$code" != "200" ]; then
    ROWS="${ROWS}| $limit | $label | did not start | | | | |\n"
    docker logs "$NAME" 2>&1 | tail -20
    FAILED=1
    docker rm -f "$NAME" >/dev/null 2>&1
    return
  fi
  after_start=$(mem_mb)
  failed=$(burst 20)
  after200=$(mem_mb)
  more=$(burst 280)
  failed=$((failed + more))
  after3000=$(mem_mb)
  oom=$(docker inspect -f '{{.State.OOMKilled}}' "$NAME")
  if [ "$oom" = "true" ] || [ "$failed" != "0" ]; then FAILED=1; fi
  ROWS="${ROWS}| $limit | $label | ${start_ms} ms | ${after_start} MB | ${after200} MB | ${after3000} MB | killed: $oom, failed requests: $failed |\n"
  docker rm -f "$NAME" >/dev/null 2>&1
}

run_case 512m "" "default heap"
run_case 512m "--max-old-space-size=256" "heap 256 MB"
run_case 1g "" "default heap"
run_case 1g "--max-old-space-size=512" "heap 512 MB"
run_case 2g "" "default heap"
run_case 2g "--max-old-space-size=1024" "heap 1024 MB"

TABLE="| Container limit | Node setting | Start to first page | After start | After 200 requests | After 3,000 requests | Result |\n| --- | --- | --- | --- | --- | --- | --- |\n${ROWS}"
printf '%b' "$TABLE"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '## Hosting baseline (S8)\n\n%b' "$TABLE" >> "$GITHUB_STEP_SUMMARY"; fi
exit "$FAILED"
