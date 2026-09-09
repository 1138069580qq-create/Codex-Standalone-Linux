#!/usr/bin/env bash
# Dependency-identical UI hotfix. Never stop a healthy service before validation.
set -Eeuo pipefail
repo=/opt/codex-webui
unit=codex-webui.service
public=http://v4.daodao.eqad.fun:26103
wanted="${1:?Pass the exact reviewed commit SHA}"
[[ "$wanted" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit'; exit 1; }
[[ "$(id -un)" == jessdaodao ]] || { echo 'Run as jessdaodao via sudo -H -u'; exit 1; }
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
cd "$repo"
git cat-file -e "$wanted^{commit}"
before=$(git rev-parse HEAD)
git merge-base --is-ancestor "$before" "$wanted" || { echo 'Refusing a downgrade or divergent update'; exit 1; }
git diff --quiet HEAD -- . ':(exclude)package-lock.json' || { echo 'Source changes found; preserve/review them before deployment'; exit 1; }
systemctl --user is-active --quiet "$unit" || { echo 'Service is not active; this hotfix will not attempt unrelated recovery'; exit 1; }
logs=$(mktemp -d "$HOME/codex-webui-ui151-XXXXXX")
printf 'LOGS=%s\nFROM=%s\nTO=%s\n' "$logs" "$before" "$wanted"
candidate="$logs/candidate"
previous="$logs/previous"
mkdir "$candidate" "$previous"
git archive "$wanted" | tar -x -C "$candidate"
git archive "$before" | tar -x -C "$previous"
[[ -d "$repo/node_modules" ]] || { echo 'Installed runtime dependencies are missing'; exit 1; }
ln -s "$repo/node_modules" "$candidate/node_modules"
# This runner is deliberately not a general dependency upgrade/install script.
node - "$repo/package.json" "$candidate/package.json" <<'NODE'
const fs=require('node:fs');const [a,b]=process.argv.slice(2).map(p=>JSON.parse(fs.readFileSync(p)));
for(const key of ['dependencies','devDependencies','engines'])if(JSON.stringify(a[key])!==JSON.stringify(b[key]))throw Error('Dependency/runtime change requires a staged full deployment: '+key);
NODE
(
  cd "$candidate"
  for file in public/*.js; do node --check "$file"; done
  node --import tsx --test tests/turn-ui.test.ts tests/turn-service.test.ts tests/preview-native.test.ts tests/preview-transfer.test.ts tests/preview-http.test.ts
) > "$logs/preflight.log" 2>&1 || { tail -35 "$logs/preflight.log"; echo 'Preflight failed; live source and service are untouched'; exit 1; }
echo 'PREFLIGHT=passed (isolated protocol tests, actual installed image runtime)'
# Preserve server-generated lockfile drift; never discard or silently reapply it.
if ! git diff --quiet HEAD -- package-lock.json; then
  cp -- package-lock.json "$logs/package-lock.before.json"
  git diff --binary HEAD -- package-lock.json > "$logs/package-lock.before.patch"
  git stash push -m "preserved lockfile before UI hotfix $wanted" -- package-lock.json
  git rev-parse 'stash@{0}' > "$logs/preserved-stash.txt"
  echo "LOCKFILE_PRESERVED=$logs/package-lock.before.json"
fi
git diff --name-only --diff-filter=M "$before" "$wanted" > "$logs/changed-existing.txt"
changed=0
healthy=0
restore_on_failure(){
  rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 && "$changed" == 1 && "$healthy" == 0 ]]; then
    echo "Update failed; restoring prior runtime files from $previous (no file deletion)."
    while IFS= read -r file; do
      [[ -f "$previous/$file" ]] || continue
      cp -- "$previous/$file" "$repo/$file" || true
    done < "$logs/changed-existing.txt"
    systemctl --user restart "$unit" || true
    echo 'ROLLBACK=runtime files restored; Git worktree retained for inspection'
  fi
  exit "$rc"
}
trap restore_on_failure EXIT
git merge --ff-only "$wanted"
changed=1
# No npm install, no lockfile clean assertion, and no stop-before-check downtime.
systemctl --user restart "$unit"
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3210/healthz > "$logs/local-health.json"; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == 1 ]] || { journalctl --user -u "$unit" -n 25 --no-pager -o cat; exit 1; }
systemctl --user is-active --quiet "$unit"
printf 'LOCAL_HEALTH=passed\nDEPLOYED_COMMIT=%s\n' "$(git rev-parse HEAD)"
# A public-network failure does not roll back an otherwise healthy deployment.
if ! curl -fsS --max-time 15 "$public/healthz" > "$logs/public-health.json"; then
  echo "PUBLIC_VERIFICATION=pending; local service healthy, verify $public from the client"
  exit 2
fi
for file in app.js state.js turns.js markdown.js features.js style.css queue.js usage.js; do
  curl -fsS --max-time 15 "$public/$file" -o "$logs/public-$file"
  [[ "$(sha256sum "$candidate/public/$file" | cut -d' ' -f1)" == "$(sha256sum "$logs/public-$file" | cut -d' ' -f1)" ]] || { echo "Public asset mismatch: $file"; exit 2; }
done
echo "PUBLIC_VERIFICATION=passed (8 exact commit assets); URL=$public/"
echo "Preserved snapshots, logs and any lockfile stash: $logs"
